import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EXIT,
  UsageError,
  assertFreeRunDir,
  parseFlags,
  parseIntIn,
  parseLatency,
  parseSpeed,
  usageText,
  type CliIo,
  type FlagSpecs,
} from "@perfidia/sim";
import { LlmLogLineSchema, type LlmLogLine } from "../log/schema.ts";
import { EFFORTS } from "../model/adapter.ts";
import { PROFILES, profileRef } from "../seat/personalities.ts";
import { seatPrompt } from "../seat/prompt.ts";
import { PreflightError } from "./preflight.ts";
import { arenaEnv, parseDuration, planArena, type ArenaEnv, type ArenaRequest } from "./plan.ts";
import { formatCost } from "./report.ts";
import { CALLS_FILE, runArena } from "./run.ts";
import { smokeCommand } from "./smoke.ts";

/** The largest seed. */
const UINT32_MAX = 4_294_967_295;

// The `arena` command line (phase-2 design §8): `bun run arena -- <command>`, where the root script
// runs `bun packages/orchestrator/src/arena/cli.ts`. Exit codes as in `sim`: 0 ok, 1 replay
// divergence, 2 fatal or aborted, 3 usage, config or preflight error. `main` takes its output
// streams and the environment as arguments, so tests run it in-process; the environment is read
// once, here, and only for `PERFIDIA_ANTHROPIC_API_KEY`, `PERFIDIA_ANTHROPIC_BASE_URL` and
// `PERFIDIA_LIVE`.

export const USAGE = [
  "usage: bun run arena -- <command> [flags]",
  "",
  "commands:",
  "  run            play a match with LLM seats and bots into a run directory",
  "  cost           spend per seat and model of a run, from its llm_calls.jsonl",
  "  personalities  list the profiles and their exact seat text",
  "  smoke          one live check of the key, the model and the request shape (needs the key)",
  "",
  "`bun run arena -- <command> --help` lists a command's flags.",
  "environment: PERFIDIA_ANTHROPIC_API_KEY (required for LLM seats unless --fake),",
  "             PERFIDIA_ANTHROPIC_BASE_URL (optional); nothing else is read.",
  "exit codes: 0 ok, 1 replay divergence, 2 fatal error or abort, 3 usage, config or preflight error",
  "",
].join("\n");

const RUN_FLAGS: FlagSpecs = {
  out: { type: "string", value: "<dir>", help: "run directory (required; must hold no run)" },
  ruleset: {
    type: "string",
    value: "<id@version | id>",
    help: "ruleset (default: the latest published perfidia-1)",
  },
  override: {
    type: "string",
    repeat: true,
    value: "<key=value>",
    help: "config override, as sim run (e.g. time.matchEnd=3600)",
  },
  players: { type: "string", value: "<N>", help: "seats (default 6)" },
  days: { type: "string", value: "<N>", help: "match length in game days (default 7)" },
  seed: { type: "string", value: "<uint32>", help: "match seed (default: random, printed)" },
  "id-key": {
    type: "string",
    value: "random|seed|<32 hex>",
    help: "secret key of opaque ids (default random)",
  },
  seat: {
    type: "string",
    repeat: true,
    value: "<pN=spec>",
    help: "pN=claude:<model>:<effort>:<profile> or pN=bot:<strategy>@<n> (default: p1–p4 claude:opus-5-5:medium with the four profiles, p5 bot:opportunist@3, p6 bot:conqueror@3)",
  },
  clock: { type: "string", value: "lockstep|realtime", help: "clock (default lockstep)" },
  time: {
    type: "string",
    value: "virtual|system",
    help: "time source (default system; virtual with --fake)",
  },
  speed: {
    type: "string",
    value: "<n | n/d>",
    help: "real time: game-seconds per second (required with real models)",
  },
  "turn-timeout": {
    type: "string",
    value: "<duration>",
    help: "real time: per round (default 5m)",
  },
  "retry-budget": {
    type: "string",
    value: "<duration>",
    help: "lockstep: retry waits per round (default 60m)",
  },
  "pause-max": {
    type: "string",
    value: "<duration>",
    help: "lockstep: total pause before the arena aborts (default 2h)",
  },
  "attempt-timeout": {
    type: "string",
    value: "<duration>",
    help: "backstop of one API attempt (default 10m)",
  },
  "bot-latency": {
    type: "string",
    value: "<lo-hi>",
    help: "real time: bots' think time in ms (default 20000-90000)",
  },
  "cap-usd": { type: "string", value: "<usd>", help: "safety cap of each LLM seat (default 100)" },
  "seat-cap": { type: "string", repeat: true, value: "<pN=usd>", help: "the cap of one seat" },
  "handoff-bot": {
    type: "string",
    value: "<strategy@n>",
    help: "the bot that takes over a seat over its cap (default: the profile's)",
  },
  "wake-cap-usd": {
    type: "string",
    value: "<usd>|off",
    help: "per-wake soft cap (default 2)",
  },
  "calibrated-usd-per-day": {
    type: "string",
    value: "<usd>",
    help: "a seat's daily spend above twice this is an alert (default: the central estimate)",
  },
  "max-inflight": {
    type: "string",
    value: "<N>",
    help: "concurrent requests per model (default 4)",
  },
  "max-tokens": { type: "string", value: "<N>", help: "output tokens per call (default 16000)" },
  "cache-ttl": {
    type: "string",
    value: "5m|1h",
    help: "TTL of the stable prefix (default 5m lockstep, 1h real time)",
  },
  "thought-call": {
    type: "string",
    value: "off|on",
    help: "out-of-band call for a missing public thought (default off)",
  },
  transcripts: {
    type: "string",
    value: "full|off",
    help: "request/response transcripts (default full)",
  },
  fake: {
    type: "boolean",
    help: "every LLM seat plays a bot-backed fake model: no API, no key, $0",
  },
  brain: {
    type: "string",
    repeat: true,
    value: "<pN=strategy@n>",
    help: "--fake: the bot a fake seat replays (default: its profile's hand-off bot)",
  },
  watch: { type: "boolean", help: "print thoughts, messages and diplomacy live" },
  invariants: {
    type: "string",
    value: "off|checkpoint|step",
    help: "invariant checks (default checkpoint)",
  },
  "snapshot-every": {
    type: "string",
    value: "<hours>",
    help: "game hours between snapshots (default 24)",
  },
  "allow-test": { type: "boolean", help: "allow a test ruleset such as sandbox-1" },
  quiet: { type: "boolean", help: "print alerts and errors only" },
};
export const RUN_USAGE = usageText("arena run --out <dir> [flags]", RUN_FLAGS);

const COST_USAGE = usageText("arena cost <run-dir>", {});
const PERSONALITIES_USAGE = usageText("arena personalities", {});
const SMOKE_FLAGS: FlagSpecs = {
  model: {
    type: "string",
    value: "<alias | id>",
    help: "opus-5-5, sonnet-5-5, haiku-5-5 or a full id (default haiku-5-5)",
  },
  effort: { type: "string", value: "<effort>", help: `${EFFORTS.join("|")} (default low)` },
};
const SMOKE_USAGE = usageText("arena smoke [--model <alias>] [--effort <effort>]", SMOKE_FLAGS);

const int = (text: string | undefined, flag: string, min: number, max: number) =>
  text === undefined ? undefined : parseIntIn(text, flag, min, max);
const duration = (text: string | undefined, flag: string) =>
  text === undefined ? undefined : parseDuration(text, flag);

/** The request and output directory of an `arena run` command line. */
export function runRequestOf(argv: readonly string[]): {
  readonly req: ArenaRequest;
  readonly out: string;
  readonly quiet: boolean;
} {
  const f = parseFlags(argv, RUN_FLAGS, RUN_USAGE, { min: 0, max: 0, name: "positional" });
  const out = f.string("out");
  if (out === undefined) throw new UsageError(`--out <dir> is required\n\n${RUN_USAGE}`);
  const speed = f.string("speed");
  const latency = f.string("bot-latency");
  const req: ArenaRequest = {
    ruleset: f.string("ruleset"),
    overrides: f.strings("override"),
    players: int(f.string("players"), "--players", 1, 1000),
    days: int(f.string("days"), "--days", 1, 3650),
    seed: int(f.string("seed"), "--seed", 0, UINT32_MAX),
    idKey: f.string("id-key"),
    seats: f.strings("seat"),
    brains: f.strings("brain"),
    clock: f.string("clock"),
    time: f.string("time"),
    speed: speed === undefined ? undefined : parseSpeed(speed),
    turnTimeoutMs: duration(f.string("turn-timeout"), "--turn-timeout"),
    retryBudgetMs: duration(f.string("retry-budget"), "--retry-budget"),
    pauseMaxMs: duration(f.string("pause-max"), "--pause-max"),
    attemptTimeoutMs: duration(f.string("attempt-timeout"), "--attempt-timeout"),
    botLatencyMs: latency === undefined ? undefined : parseLatency(latency),
    capUsd: f.string("cap-usd"),
    seatCaps: f.strings("seat-cap"),
    handoffBot: f.string("handoff-bot"),
    wakeCapUsd: f.string("wake-cap-usd"),
    calibratedUsdPerDay: f.string("calibrated-usd-per-day"),
    maxInflight: int(f.string("max-inflight"), "--max-inflight", 1, 64),
    maxTokens: int(f.string("max-tokens"), "--max-tokens", 1, 128_000),
    cacheTtl: f.string("cache-ttl"),
    thoughtCall: f.string("thought-call"),
    transcripts: f.string("transcripts"),
    watch: f.bool("watch"),
    fake: f.bool("fake"),
    invariants: f.string("invariants"),
    snapshotEvery: int(f.string("snapshot-every"), "--snapshot-every", 0, 100_000),
    allowTest: f.bool("allow-test"),
  };
  return { req, out, quiet: f.bool("quiet") };
}

async function runCommand(argv: readonly string[], io: CliIo, env: ArenaEnv): Promise<number> {
  const { req, out, quiet } = runRequestOf(argv);
  const plan = planArena(req, env);
  assertFreeRunDir(out);
  try {
    const outcome = await runArena(plan, { dir: out, io, quiet });
    if (outcome.status !== "ended") {
      io.err(`arena run: ${outcome.status}: ${outcome.report.reason ?? outcome.error ?? ""}\n`);
    }
    return outcome.code;
  } catch (e) {
    if (e instanceof PreflightError) throw new UsageError(`${e.message} (nothing was written)`);
    throw e;
  }
}

function readCalls(dir: string): LlmLogLine[] {
  const path = existsSync(dir) && statSync(dir).isDirectory() ? join(dir, CALLS_FILE) : dir;
  if (!existsSync(path))
    throw new UsageError(`${dir}: no ${CALLS_FILE} (not an arena run directory)`);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((row) => row !== "")
    .map((row, i) => {
      const parsed = LlmLogLineSchema.safeParse(JSON.parse(row));
      if (!parsed.success) throw new UsageError(`${path}: line ${i + 1} is not an LLM log line`);
      return parsed.data;
    });
}

function personalities(io: CliIo): number {
  for (const p of PROFILES) {
    io.out(`${profileRef(p)} (hand-off bot ${p.handoffBot})\n`);
    io.out(`${seatPrompt("p1", p).replace("You play p1.", "You play {seat}.")}\n\n`);
  }
  return EXIT.ok;
}

function dispatch(
  command: string,
  argv: readonly string[],
  io: CliIo,
  env: ArenaEnv,
): Promise<number> | number {
  switch (command) {
    case "run":
      return runCommand(argv, io, env);
    case "cost": {
      const f = parseFlags(argv, {}, COST_USAGE, { min: 1, max: 1, name: "run" });
      io.out(formatCost(readCalls(f.positionals[0] ?? "")));
      return EXIT.ok;
    }
    case "personalities":
      parseFlags(argv, {}, PERSONALITIES_USAGE, { min: 0, max: 0, name: "positional" });
      return personalities(io);
    case "smoke": {
      const f = parseFlags(argv, SMOKE_FLAGS, SMOKE_USAGE, { min: 0, max: 0, name: "positional" });
      const effort = f.string("effort");
      const e = effort === undefined ? undefined : EFFORTS.find((x) => x === effort);
      if (effort !== undefined && e === undefined) {
        throw new UsageError(`--effort must be one of ${EFFORTS.join(", ")}, got "${effort}"`);
      }
      const model = f.string("model");
      return smokeCommand({
        env,
        io,
        ...(model === undefined ? {} : { model }),
        ...(e === undefined ? {} : { effort: e }),
      });
    }
    default:
      throw new UsageError(`unknown command "${command}"\n\n${USAGE}`);
  }
}

const COMMAND_USAGE: Readonly<Record<string, string>> = {
  run: RUN_USAGE,
  cost: COST_USAGE,
  personalities: PERSONALITIES_USAGE,
  smoke: SMOKE_USAGE,
};

/** Runs one `arena` command line; returns its exit code. Never throws. */
export async function main(
  argv: readonly string[],
  io: CliIo,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
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
    return await dispatch(command, rest, io, arenaEnv(env));
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`arena ${command}: ${error.message}\n`);
      return EXIT.usage;
    }
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    io.err(`arena ${command}: error: ${text}\n`);
    return EXIT.fatal;
  }
}

if (import.meta.main) {
  const code = await main(
    process.argv.slice(2),
    {
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    },
    process.env,
  );
  // A real-time abort can leave a bot's think-time timer behind: exit once the run is reported.
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}
