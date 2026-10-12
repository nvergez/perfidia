import { join } from "node:path";
import { DAY } from "@perfidia/engine/core";
import {
  EXIT,
  UINT32_MAX,
  parseFlags,
  parseIntIn,
  parseLatency,
  parseSpeed,
  usageText,
  type CliIo,
  type FlagSpecs,
} from "../args.ts";
import { DEFAULT_BOTS } from "../harness/index.ts";
import { assertFreeRunDir, freeRunDir } from "../io/index.ts";
import { formatSummary } from "../summary/index.ts";
import { planRun, type RunPlan, type RunRequest } from "./plan.ts";
import { executeRun } from "./run.ts";

// `sim run` (docs/architecture.md §12.1).

const FLAGS: FlagSpecs = {
  ruleset: {
    type: "string",
    value: "<id@version | id>",
    help: "ruleset (default: the latest published perfidia-1)",
  },
  override: {
    type: "string",
    repeat: true,
    value: "<key=value>",
    help: "config override, validated by the ruleset's schema and the config checks",
  },
  seed: { type: "string", value: "<uint32>", help: "match seed (default 1)" },
  players: {
    type: "string",
    value: "<N>",
    help: "number of seats (default: the ruleset's minimum)",
  },
  days: {
    type: "string",
    value: "<N>",
    help: "match length in game days (time.matchEnd = N·86400)",
  },
  "id-key": {
    type: "string",
    value: "<32 hex> | random",
    help: "secret key of opaque ids (default: derived from the seed, not secret)",
  },
  bots: {
    type: "string",
    value: "<a,b,…>",
    help: `bots cycled over the seats, name or name@n (default ${DEFAULT_BOTS.join(",")}, each at its latest version)`,
  },
  seat: {
    type: "string",
    repeat: true,
    value: "<pN=bot>",
    help: "the bot of one seat, name or name@n",
  },
  clock: { type: "string", value: "lockstep|realtime", help: "clock (default lockstep)" },
  time: {
    type: "string",
    value: "virtual|system",
    help: "real-time clock source (default virtual)",
  },
  speed: { type: "string", value: "<n | n/d>", help: "game-seconds per wall-second (default 3)" },
  latency: {
    type: "string",
    value: "<lo-hi>",
    help: "bot think time per round in wall ms (default 2000-60000 virtual, none system)",
  },
  invariants: {
    type: "string",
    value: "off|checkpoint|step",
    help: "invariant checks (default checkpoint)",
  },
  "snapshot-every": {
    type: "string",
    value: "<hours>",
    help: "game hours between snapshots, 0 for the final one only (default 24)",
  },
  "trace-hashes": {
    type: "boolean",
    help: "write trace.jsonl: the state hash after every action, from a replay of the written log (not the live engine)",
  },
  "allow-test": { type: "boolean", help: "allow a test ruleset such as sandbox-1" },
  out: {
    type: "string",
    value: "<dir>",
    help: "run directory (default runs/<ref>-s<seed>-<N>p-<length>-<clock>)",
  },
  quiet: { type: "boolean", help: "print nothing but errors" },
  json: { type: "boolean", help: "print the summary as JSON" },
};
export const RUN_USAGE = usageText("sim run [flags]", FLAGS);

const int = (
  text: string | undefined,
  flag: string,
  min: number,
  max: number,
): number | undefined => (text === undefined ? undefined : parseIntIn(text, flag, min, max));

/** The run request of a command line (values parsed, not yet checked against a ruleset). */
export function runRequestOf(argv: readonly string[]): {
  readonly req: RunRequest;
  readonly out: string | undefined;
  readonly quiet: boolean;
  readonly json: boolean;
} {
  const f = parseFlags(argv, FLAGS, RUN_USAGE, { min: 0, max: 0, name: "positional" });
  const speed = f.string("speed");
  const latency = f.string("latency");
  const req: RunRequest = {
    ruleset: f.string("ruleset"),
    overrides: f.strings("override"),
    seed: int(f.string("seed"), "--seed", 0, UINT32_MAX),
    players: int(f.string("players"), "--players", 1, 1000),
    days: int(f.string("days"), "--days", 1, 3650),
    idKey: f.string("id-key"),
    bots: f.has("bots") ? f.strings("bots") : undefined,
    seats: f.strings("seat"),
    clock: f.string("clock"),
    time: f.string("time"),
    speed: speed === undefined ? undefined : parseSpeed(speed),
    latencyMs: latency === undefined ? undefined : parseLatency(latency),
    invariants: f.string("invariants"),
    snapshotEvery: int(f.string("snapshot-every"), "--snapshot-every", 0, 100000),
    traceHashes: f.bool("trace-hashes"),
    allowTest: f.bool("allow-test"),
  };
  return { req, out: f.string("out"), quiet: f.bool("quiet"), json: f.bool("json") };
}

/** `runs/perfidia-1@1.0.0-s1-6p-1d-lockstep`, the base name of a run's default directory. */
export function defaultRunDir(plan: RunPlan): string {
  const end = plan.setup.overrides["time.matchEnd"];
  const length =
    typeof end === "number" ? (end % DAY === 0 ? `${end / DAY}d` : `${end}s`) : "default";
  const clock =
    plan.clock.kind === "lockstep"
      ? "lockstep"
      : plan.clock.kind === "virtual"
        ? "rt-virtual"
        : "rt-system";
  return join(
    "runs",
    `${plan.ruleset.ref}-s${plan.setup.seed}-${plan.setup.seats.length}p-${length}-${clock}`,
  );
}

export async function runCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const { req, out, quiet, json } = runRequestOf(argv);
  const plan = planRun(req);
  let dir: string;
  if (out === undefined) dir = freeRunDir(defaultRunDir(plan));
  else {
    assertFreeRunDir(out);
    dir = out;
  }
  if (!quiet && !json) io.out(`run directory: ${dir}\n`);
  const outcome = await executeRun(plan, dir);
  if (outcome.error !== null) io.err(`sim run: ${outcome.error}\n`);
  if (json) io.out(`${JSON.stringify(outcome.summary, null, 2)}\n`);
  else if (!quiet) {
    io.out(formatSummary(outcome.summary));
    if (outcome.traced !== null)
      io.out(`trace: ${outcome.traced} actions in ${outcome.paths.trace}\n`);
  }
  return outcome.code === EXIT.ok ? EXIT.ok : outcome.code;
}
