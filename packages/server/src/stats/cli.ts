import { renameSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  MatchStatsSchema,
  ModelStatsFileSchema,
  StatsGroupingSchema,
  type StatsGrouping,
} from "@perfidia/protocol";
import { PublishList } from "../store/publish.ts";
import { DEFAULT_REPLICATES, DEFAULT_SEED, aggregate } from "./aggregate.ts";
import { formatMatch, formatModels, formatPower, terminalText } from "./report.ts";
import { statsOfRoot, statsOfRunDir } from "./runs.ts";
import { readSeries } from "./side.ts";
import { simulatePower } from "./simulate.ts";

// `bun run stats -- <command>` (phase-4 design §6.3): per-model statistics of run directories.
// - `match <run-dir>`: one match, seat by seat (`perfidia-stats/1` with `--json`);
// - `aggregate --runs <dir>`: every run directory under a root (as the server discovers them; a
//   rotation series' `series.json` at the root groups them into blocks), per model, with the claim
//   state and, once it is met, the ratings (`perfidia-model-stats/1` with `--json`; `--out <file>`
//   writes what the server's `--stats <file>` serves); `--publish <file>` keeps the public matches;
// - `power`: the matches a claim needs (exact) and the pipeline's simulated power.
// Exit codes: 0 ok, 2 a run directory cannot be read, 3 usage. Only the run directories are read.

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export const USAGE = [
  "usage: bun run stats -- <command> [flags]",
  "",
  "commands:",
  "  match <run-dir> [--json] [--no-costs]",
  "      one match, seat by seat",
  "  aggregate --runs <dir> [--publish <file>] [--group model|profile|variant|model-profile]",
  "            [--seed N] [--replicates N] [--no-costs] [--exploratory] [--json] [--out <file>]",
  "      every run directory under <dir>, per model; the claim state; ratings once it is met",
  "      (--exploratory: outcomes and ratings below the threshold too, never servable)",
  "  power [--p 0.7] [--matches 12,20,32,48,76] [--reps 200] [--replicates 200] [--seed N] [--json]",
  "      matches a head-to-head claim needs (exact binomial) and the rating pipeline's simulated power",
  "      (--p 0.5: equal models, so the rates are false claims: the size)",
  "",
].join("\n");

class UsageError extends Error {}

const EXIT = { ok: 0, run: 2, usage: 3 } as const;

function intFlag(text: string | undefined, name: string, fallback: number, min = 0): number {
  if (text === undefined) return fallback;
  if (!/^[0-9]{1,9}$/.test(text) || Number(text) < min) {
    throw new UsageError(
      `--${name} must be an integer of at least ${min}, got ${JSON.stringify(text)}`,
    );
  }
  return Number(text);
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function matchCommand(args: readonly string[], io: CliIo): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: true,
    options: { json: { type: "boolean" }, "no-costs": { type: "boolean" } },
  });
  const dir = positionals[0];
  if (dir === undefined || positionals.length > 1)
    throw new UsageError("match takes one run directory");
  const series = readSeries(dirname(resolve(dir)));
  const name = basename(resolve(dir));
  const r = statsOfRunDir(dir, {
    costs: values["no-costs"] !== true,
    series: series.byRun.get(name) ?? null,
  });
  for (const w of r.warnings) io.err(`warning: ${terminalText(w)}\n`);
  const fits = MatchStatsSchema.safeParse(r.stats);
  if (!fits.success) {
    const where = fits.error.issues[0]?.path.join(".") ?? "";
    io.err(`stats: ${name}: its statistics do not fit perfidia-stats/1 (at ${where})\n`);
    return EXIT.run;
  }
  if (values.json === true) io.out(`${JSON.stringify(fits.data, null, 2)}\n`);
  else io.out(formatMatch(fits.data));
  return EXIT.ok;
}

function aggregateCommand(args: readonly string[], io: CliIo): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      runs: { type: "string" },
      publish: { type: "string" },
      group: { type: "string" },
      seed: { type: "string" },
      replicates: { type: "string" },
      "no-costs": { type: "boolean" },
      exploratory: { type: "boolean" },
      json: { type: "boolean" },
      out: { type: "string" },
    },
  });
  if (positionals.length > 0) throw new UsageError("aggregate takes no positional argument");
  if (values.runs === undefined) throw new UsageError("aggregate needs --runs <dir>");
  let grouping: StatsGrouping = "model";
  if (values.group !== undefined) {
    const g = StatsGroupingSchema.safeParse(values.group);
    if (!g.success) {
      throw new UsageError(`--group must be one of ${StatsGroupingSchema.options.join(", ")}`);
    }
    grouping = g.data;
  }
  const seed = intFlag(values.seed, "seed", DEFAULT_SEED);
  const replicates = intFlag(values.replicates, "replicates", DEFAULT_REPLICATES);
  let publish: PublishList | null = null;
  if (values.publish !== undefined) {
    publish = new PublishList(values.publish);
    try {
      publish.load({ first: true });
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message : String(e));
    }
  }
  const costs = values["no-costs"] !== true;
  const root = statsOfRoot(values.runs, { costs, publish });
  for (const w of root.warnings) io.err(`warning: ${terminalText(w)}\n`);
  const file = ModelStatsFileSchema.parse(
    aggregate(
      root.runs.map((r) => r.stats),
      {
        grouping,
        costs,
        seed,
        replicates,
        exploratory: values.exploratory === true,
        series: root.series,
      },
    ),
  );
  const json = `${JSON.stringify(file, null, 2)}\n`;
  if (values.out !== undefined) {
    writeAtomic(values.out, json);
    io.err(`wrote ${values.out} (${file.matches.length} matches)\n`);
  }
  if (values.json === true) io.out(json);
  else io.out(formatModels(file));
  return EXIT.ok;
}

function powerCommand(args: readonly string[], io: CliIo): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      p: { type: "string" },
      matches: { type: "string" },
      reps: { type: "string" },
      replicates: { type: "string" },
      seed: { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (positionals.length > 0) throw new UsageError("power takes no positional argument");
  const p = values.p === undefined ? 0.7 : Number(values.p);
  if (!(p >= 0.5 && p < 1)) {
    throw new UsageError("--p must be a probability from 0.5 (the size: equal models) to below 1");
  }
  const matches = (values.matches ?? "12,20,32,48,76")
    .split(",")
    .map((m) => intFlag(m, "matches", 0, 1));
  const reps = intFlag(values.reps, "reps", 200, 1);
  const replicates = intFlag(values.replicates, "replicates", 200);
  const seed = intFlag(values.seed, "seed", DEFAULT_SEED);
  const rows = simulatePower({ p, matches, reps, replicates, seed });
  if (values.json === true)
    io.out(`${JSON.stringify({ p, reps, replicates, seed, rows }, null, 2)}\n`);
  else io.out(formatPower(p, rows, { reps, replicates }));
  return EXIT.ok;
}

/** Runs the command line; returns the exit code. */
export function main(argv: readonly string[], io: CliIo): number {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "match":
        return matchCommand(rest, io);
      case "aggregate":
        return aggregateCommand(rest, io);
      case "power":
        return powerCommand(rest, io);
      case undefined:
      case "--help":
      case "help":
        io.out(USAGE);
        return command === undefined ? EXIT.usage : EXIT.ok;
      default:
        throw new UsageError(`unknown command ${JSON.stringify(command)}`);
    }
  } catch (e) {
    if (e instanceof UsageError || (e instanceof TypeError && "code" in e)) {
      io.err(`stats: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    io.err(`stats: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.run;
  }
}

if (import.meta.main) {
  const code = main(process.argv.slice(2), {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  });
  process.exitCode = code;
}
