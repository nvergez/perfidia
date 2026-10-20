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
import { capabilitiesFor, seatModels } from "../model/catalog.ts";
import { PROFILES, profileRef } from "../seat/personalities.ts";
import { seatPrompt } from "../seat/prompt.ts";
import { PROFILES_DIR, calibrate, formatCalibrate } from "./calibrate.ts";
import { formatCardTable, formatEstimate } from "./estimate.ts";
import { PRESETS } from "./lineup.ts";
import { PreflightError } from "./preflight.ts";
import {
  arenaEnv,
  parseDuration,
  planArena,
  randomSeed,
  providerEnv,
  type ArenaEnv,
  type ArenaRequest,
} from "./plan.ts";
import {
  EXIT_RECONCILE,
  RECONCILE_AFTER_HOURS,
  formatReconcile,
  inputFromFlags,
  readInput,
  reconcileDir,
} from "./reconcile.ts";
import { formatCost } from "./report.ts";
import { CALLS_FILE, runArena, type SignalSource } from "./run.ts";
import { geminiSmokeCommand } from "./providers/gemini-smoke.ts";
import { startRecording } from "./record.ts";
import { runSeries } from "./series.ts";
import { smokeCommand } from "./smoke.ts";
import { planLive, smokeOpenRouter } from "./providers/openrouter.ts";

/** The largest seed. */
const UINT32_MAX = 4_294_967_295;

// The `arena` command line (phase-2 design §8; phase-4 design §5, Pass 1a): `bun run arena --
// <command>`, where the root script runs `bun packages/orchestrator/src/arena/cli.ts`. Exit codes
// as in `sim`: 0 ok, 1 replay divergence, 2 fatal or aborted, 3 usage, config, budget or preflight
// error; 4: `arena reconcile` outside tolerance. `main` takes its output streams, the environment
// and the signal source as arguments, so tests run it in-process; the environment is read once,
// here, and only for `PERFIDIA_ANTHROPIC_API_KEY`, `PERFIDIA_ANTHROPIC_BASE_URL` and
// `PERFIDIA_LIVE` (Pass 1b: `PERFIDIA_<PROVIDER>_API_KEY` and `_BASE_URL` for openai, google,
// openrouter and compat too). `arena run` takes over SIGINT, SIGTERM and SIGHUP from before its start
// preflight: the first hands every LLM seat to its bot (or stops the start preflight, nothing
// written), the second aborts the run, a third exits at once (after an `operator` line).

export const USAGE = [
  "usage: bun run arena -- <command> [flags]",
  "",
  "commands:",
  "  run            play a match with LLM seats and bots into a run directory",
  "  estimate       the prediction, reserve and kill threshold of a run, without running it",
  "  cost           spend per seat and model of a run, from its llm_calls.jsonl",
  "  reconcile      check a run's ledger against the provider's usage pages (48 h after it)",
  "  calibrate      measure real runs into calibration profiles (and 7-day --fake runs' briefing growth)",
  "  series         play a lineup as rotated matches (Latin squares over seats and profiles)",
  "  personalities  list the profiles and their exact seat text",
  "  smoke          one live check of the key, the model and the request shape (needs the key)",
  "",
  "`bun run arena -- <command> --help` lists a command's flags.",
  `lineup presets: ${PRESETS.join(", ")} (packages/orchestrator/lineups/)`,
  "environment: PERFIDIA_<PROVIDER>_API_KEY for each provider a seat plays on, unless --fake",
  "             (ANTHROPIC, OPENAI, GOOGLE, OPENROUTER; COMPAT: optional on loopback), and",
  "             PERFIDIA_<PROVIDER>_BASE_URL (optional; required for COMPAT); nothing else is read.",
  "             This build calls all five (Anthropic, OpenAI, Google, OpenRouter, compat); --fake",
  "             rehearses any lineup at $0.",
  "exit codes: 0 ok, 1 replay divergence, 2 fatal error, abort or degraded run, 3 usage, config,",
  "            budget or preflight error, 4 reconciliation outside tolerance",
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
  "stop-after": {
    type: "string",
    value: "<N>",
    help: "stop the run at the end of game day N, the match keeping its length (calibration)",
  },
  seed: { type: "string", value: "<uint32>", help: "match seed (default: random, printed)" },
  "id-key": {
    type: "string",
    value: "random|seed|<32 hex>",
    help: "secret key of opaque ids (default random)",
  },
  lineup: {
    type: "string",
    value: "<preset | file>",
    help: `a perfidia-lineup/1 file or a preset (${PRESETS.join(", ")}): seats, limits and the match budget`,
  },
  seat: {
    type: "string",
    repeat: true,
    value: "<pN=spec>",
    help: "pN=claude:<model>:<effort>:<profile>, pN=<provider>:<model>[@<endpoint>]:<effort>:<profile> or pN=bot:<strategy>@<n>, over the lineup (default: p1–p4 claude:opus-5-5:medium with the four profiles, p5 bot:opportunist@3, p6 bot:conqueror@3)",
  },
  "price-date": {
    type: "string",
    value: "<YYYY-MM-DD>",
    help: "--fake runs and estimates: price at the cards of that UTC day (default: today; a real run prices each attempt at its start)",
  },
  profiles: {
    type: "string",
    value: "<dir>|off",
    help: "calibration profiles the prediction draws on (arena calibrate; default packages/orchestrator/profiles/; off: the scenario only)",
  },
  "budget-usd": {
    type: "string",
    value: "<usd>",
    help: "the match budget: the kill switch keeps the run's spend under it (default: the lineup's; none without a lineup)",
  },
  "on-budget": {
    type: "string",
    value: "handoff|abort",
    help: "when the kill switch fires: hand every LLM seat to its bot and play on, or abort (default handoff)",
  },
  "budget-carry": {
    type: "string",
    value: "<run-dir>",
    help: "a crashed run of the same budget: its logged spend counts toward this run's budget",
  },
  "prompt-cap": {
    type: "string",
    value: "<tokens>",
    help: "an attempt whose estimated prompt is over it is not sent; its turn closes (default 160000)",
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

/** `arena estimate` plans like `arena run` (same flags but the output ones) and prints the prediction. */
const ESTIMATE_FLAGS: FlagSpecs = {
  ...Object.fromEntries(
    Object.entries(RUN_FLAGS).filter(
      ([k]) => !["out", "watch", "quiet", "transcripts", "brain"].includes(k),
    ),
  ),
  cards: {
    type: "boolean",
    help: "print every seat model's card with its scenario estimate (7-day lockstep, medium), instead of a run's",
  },
};
export const ESTIMATE_USAGE = usageText(
  "arena estimate [--lineup <preset | file>] [flags]",
  ESTIMATE_FLAGS,
);

const COST_FLAGS: FlagSpecs = {
  reprice: { type: "boolean", help: "also price every line at today's cards, with the difference" },
};
const COST_USAGE = usageText("arena cost <run-dir> [--reprice]", COST_FLAGS);
const RECONCILE_FLAGS: FlagSpecs = {
  input: {
    type: "string",
    value: "<file>",
    help: "a perfidia-reconcile-input/1 file: per provider, the pre-tax usage cost (and token counts) of the run's wall-clock window",
  },
  usd: {
    type: "string",
    repeat: true,
    value: "<provider=usd>",
    help: "the pre-tax usage cost of one provider, without token counts (e.g. anthropic=12.34)",
  },
  force: {
    type: "boolean",
    help: "fill exit4.reconciled even under 48 hours after the run (usage pages may still lag)",
  },
};
const RECONCILE_USAGE = usageText(
  "arena reconcile <run-dir> (--input <file> | --usd <provider=usd> ...) [--force]",
  RECONCILE_FLAGS,
);
const CALIBRATE_FLAGS: FlagSpecs = {
  profiles: {
    type: "string",
    value: "<dir>",
    help: "where the profiles are kept (default packages/orchestrator/profiles/): a run measured again replaces its seat-days",
  },
};
const CALIBRATE_USAGE = usageText(
  "arena calibrate <run-dir>... [--profiles <dir>]   (real runs give seat-days; 7-day --fake runs give the briefing growth only)",
  CALIBRATE_FLAGS,
);
/** `arena series`: the run flags every match shares, and the series' own. */
const SERIES_FLAGS: FlagSpecs = {
  ...Object.fromEntries(
    Object.entries(RUN_FLAGS).filter(
      ([k]) => !["out", "seat", "seed", "brain", "budget-carry", "watch", "lineup"].includes(k),
    ),
  ),
  lineup: {
    type: "string",
    value: "<preset | file>",
    help: "the lineup whose LLM seat entries and profiles rotate (required)",
  },
  out: {
    type: "string",
    value: "<dir>",
    help: "the series directory: series.json, lineups/ and one run directory per match (required)",
  },
  blocks: {
    type: "string",
    value: "<N>",
    help: "blocks of rotated matches, each as many matches as the lineup has LLM seats (default 1)",
  },
  seed: {
    type: "string",
    value: "<uint32>",
    help: "series seed: the squares, and the game seed of block b (seed + b) (default: random, printed)",
  },
};
const SERIES_USAGE = usageText(
  "arena series --lineup <preset | file> --out <dir> [--blocks N] [--seed S] [run flags]",
  SERIES_FLAGS,
);
const PERSONALITIES_USAGE = usageText("arena personalities", {});
/** The efforts a Claude smoke takes. */
const CLAUDE_EFFORTS = capabilitiesFor("anthropic", "claude-haiku-5-5").efforts;
/** The providers `arena smoke` checks (`gemini` is an alias of `google`). */
const SMOKE_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
  "gemini",
  "openrouter",
]);
const SMOKE_FLAGS: FlagSpecs = {
  provider: {
    type: "string",
    value: "<provider>",
    help: "anthropic (default), openai, google (alias gemini) or openrouter: needs PERFIDIA_<PROVIDER>_API_KEY",
  },
  model: {
    type: "string",
    value: "<alias | id>",
    help: "anthropic: opus-5-5, sonnet-5-5, haiku-5-5, fable-5-1 or a full id (default haiku-5-5); another provider: one of its seat models (openai: default gpt-6-luna; google: default gemini-3.8-flash; openrouter: default z-ai/glm-5.3-flash)",
  },
  effort: {
    type: "string",
    value: "<effort>",
    help: `anthropic: ${CLAUDE_EFFORTS.join("|")}; another provider: one the model accepts; default low (openrouter: medium)`,
  },
  endpoint: {
    type: "string",
    value: "<slug>",
    help: "openrouter: the full endpoint slug (default the model's catalogued one, e.g. z-ai/fp8)",
  },
  record: {
    type: "string",
    value: "<dir>",
    help: "write every exchange, sanitised (keys, request and account ids replaced), as a perfidia-recording/1 file into <dir> (new or empty)",
  },
};
const SMOKE_USAGE = usageText(
  "arena smoke [--provider <p>] [--model <alias | id>] [--endpoint <slug>] [--effort <effort>] [--record <dir>]",
  SMOKE_FLAGS,
);

const int = (text: string | undefined, flag: string, min: number, max: number) =>
  text === undefined ? undefined : parseIntIn(text, flag, min, max);
const duration = (text: string | undefined, flag: string) =>
  text === undefined ? undefined : parseDuration(text, flag);

type Flags = ReturnType<typeof parseFlags>;

/** The request and output directory of an `arena run` command line. */
export function runRequestOf(
  argv: readonly string[],
  profilesDir: string = PROFILES_DIR,
): {
  readonly req: ArenaRequest;
  readonly out: string;
  readonly quiet: boolean;
} {
  const f = parseFlags(argv, RUN_FLAGS, RUN_USAGE, { min: 0, max: 0, name: "positional" });
  const out = f.string("out");
  if (out === undefined) throw new UsageError(`--out <dir> is required\n\n${RUN_USAGE}`);
  return { req: requestOf(f, profilesDir), out, quiet: f.bool("quiet") };
}

/** The plan request of `arena run` or `arena estimate` flags (`--profiles` default: `profilesDir`). */
function requestOf(f: Flags, profilesDir: string): ArenaRequest {
  const speed = f.string("speed");
  const latency = f.string("bot-latency");
  const req: ArenaRequest = {
    ruleset: f.string("ruleset"),
    overrides: f.strings("override"),
    players: int(f.string("players"), "--players", 1, 1000),
    days: int(f.string("days"), "--days", 1, 3650),
    stopAfterDays: int(f.string("stop-after"), "--stop-after", 1, 3650),
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
    lineup: f.string("lineup"),
    budgetUsd: f.string("budget-usd"),
    onBudget: f.string("on-budget"),
    budgetCarry: f.string("budget-carry"),
    promptCap: int(f.string("prompt-cap"), "--prompt-cap", 1_000, 1_000_000),
    priceDate: f.string("price-date"),
    profiles: f.string("profiles") ?? profilesDir,
  };
  return req;
}

async function runCommand(
  argv: readonly string[],
  io: CliIo,
  env: ArenaEnv,
  signals: SignalSource | undefined,
  nowMs: () => number,
  profilesDir: string,
): Promise<number> {
  const { req, out, quiet } = runRequestOf(argv, profilesDir);
  // OpenRouter seats of a real run are planned on OpenRouter's live endpoint metadata (Pass 2).
  const plan = await planLive(req, env, { now: nowMs });
  assertFreeRunDir(out);
  try {
    const outcome = await runArena(plan, {
      dir: out,
      io,
      quiet,
      ...(signals === undefined ? {} : { signals }),
    });
    if (outcome.status !== "ended" && outcome.status !== "stopped") {
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

/** `arena estimate`: plans like `arena run` (no key needed, nothing sent) and prints the prediction. */
function estimateCommand(
  argv: readonly string[],
  io: CliIo,
  env: ArenaEnv,
  nowMs: () => number,
  profilesDir: string,
): number {
  const f = parseFlags(argv, ESTIMATE_FLAGS, ESTIMATE_USAGE, {
    min: 0,
    max: 0,
    name: "positional",
  });
  if (f.bool("cards")) {
    io.out(formatCardTable());
    return EXIT.ok;
  }
  const plan = planArena(requestOf(f, profilesDir), env, { requireKey: false, now: nowMs });
  io.out(formatEstimate(plan.estimate));
  for (const w of plan.warnings) io.out(`warning: ${w}\n`);
  return EXIT.ok;
}

/** `arena reconcile`: exit 0 within tolerance, 4 outside it. */
function reconcileCommand(argv: readonly string[], io: CliIo, nowMs: number): number {
  const f = parseFlags(argv, RECONCILE_FLAGS, RECONCILE_USAGE, { min: 1, max: 1, name: "run" });
  const dir = f.positionals[0] ?? "";
  const file = f.string("input");
  const usd = f.strings("usd");
  if ((file === undefined) === (usd.length === 0)) {
    throw new UsageError(
      `give the provider figures with exactly one of --input <file> and --usd\n\n${RECONCILE_USAGE}`,
    );
  }
  const input = file === undefined ? inputFromFlags(usd) : readInput(file);
  const force = f.bool("force");
  const r = reconcileDir(dir, input, nowMs, { force });
  if (r.hoursAfterEnd === null) {
    io.err("warning: the run's wall-clock times are virtual (a --fake run): no 48-hour check\n");
  } else if (r.early) {
    io.err(
      `warning: only ${r.hoursAfterEnd} h since the run's wall-clock end: usage pages can lag up to a day; reconcile again after ${RECONCILE_AFTER_HOURS} h${force ? " (--force: exit4.reconciled is filled anyway)" : " (exit4.reconciled stays null until then; --force fills it now)"}\n`,
    );
  }
  io.out(formatReconcile(r));
  const filled = r.early && !force ? null : r.ok;
  io.out(`wrote ${dir}/reconcile.json; arena.json exit4.reconciled = ${filled}\n`);
  return r.ok ? EXIT.ok : EXIT_RECONCILE;
}

/** `arena calibrate`: measures run directories into the profiles. */
function calibrateCommand(argv: readonly string[], io: CliIo, profilesDir: string): number {
  const f = parseFlags(argv, CALIBRATE_FLAGS, CALIBRATE_USAGE, {
    min: 1,
    max: Infinity,
    name: "run",
  });
  io.out(
    formatCalibrate(calibrate(f.positionals, { profilesDir: f.string("profiles") ?? profilesDir })),
  );
  return EXIT.ok;
}

/** `arena series`: a rotation series of a lineup (exit code of the first match that failed). */
function seriesCommand(
  argv: readonly string[],
  io: CliIo,
  env: ArenaEnv,
  signals: SignalSource | undefined,
  nowMs: () => number,
  profilesDir: string,
): Promise<number> {
  const f = parseFlags(argv, SERIES_FLAGS, SERIES_USAGE, { min: 0, max: 0, name: "positional" });
  const lineup = f.string("lineup");
  const out = f.string("out");
  if (lineup === undefined || out === undefined) {
    throw new UsageError(`--lineup and --out are required\n\n${SERIES_USAGE}`);
  }
  const given = int(f.string("seed"), "--seed", 0, UINT32_MAX);
  const seed = given ?? randomSeed();
  if (given === undefined) io.out(`series seed ${seed} (random; pass --seed ${seed} to replay)\n`);
  return runSeries({
    lineup,
    out,
    blocks: int(f.string("blocks"), "--blocks", 1, 1000) ?? 1,
    seed,
    // Each match's lineup file and game seed replace the request's.
    request: requestOf(f, profilesDir),
    env,
    io,
    quiet: f.bool("quiet"),
    now: nowMs,
    ...(signals === undefined ? {} : { signals }),
  });
}

/** What `main` takes besides its streams and environment (the process's by default). */
export interface MainOptions {
  /** `arena run`'s operator signals. */
  readonly signals?: SignalSource;
  /** The wall clock in ms (`arena reconcile`'s 48-hour check). */
  readonly nowMs?: () => number;
  /**
   * The profiles directory when no `--profiles` is given (default `PROFILES_DIR`): the tests pass
   * `off`, so profiles an owner calibrates into the source tree never change pinned figures.
   */
  readonly profilesDir?: string;
}

/** `arena smoke`: one provider's live check, recorded when `--record` names a directory. */
async function smoke(
  argv: readonly string[],
  io: CliIo,
  env: ArenaEnv,
  o: MainOptions,
): Promise<number> {
  const f = parseFlags(argv, SMOKE_FLAGS, SMOKE_USAGE, { min: 0, max: 0, name: "positional" });
  const provider = f.string("provider") ?? "anthropic";
  if (!SMOKE_PROVIDERS.has(provider)) {
    throw new UsageError(
      `--provider must be anthropic, openai, google (gemini) or openrouter, got "${provider}"`,
    );
  }
  const effort = f.string("effort");
  // Another provider's efforts are checked against its model by its smoke (Pass 2).
  const efforts = provider === "anthropic" ? CLAUDE_EFFORTS : EFFORTS;
  const e = effort === undefined ? undefined : efforts.find((x) => x === effort);
  if (effort !== undefined && e === undefined) {
    throw new UsageError(`--effort must be one of ${efforts.join(", ")}, got "${effort}"`);
  }
  const model = f.string("model");
  const endpoint = f.string("endpoint");
  if (endpoint !== undefined && provider !== "openrouter") {
    throw new UsageError("--endpoint applies to --provider openrouter only");
  }
  const id = provider === "gemini" ? "google" : provider;
  const dir = f.string("record");
  const key = id === "anthropic" ? env.apiKey : providerEnv(env, id).apiKey;
  const recording =
    dir === undefined
      ? null
      : startRecording(dir, {
          provider: id,
          secrets: key === null ? [] : [key],
          now: o.nowMs ?? Date.now,
          keep: seatModels(id).map((m) => m.model),
        });
  const common = {
    env,
    io,
    ...(model === undefined ? {} : { model }),
    ...(e === undefined ? {} : { effort: e }),
    ...(recording === null ? {} : { fetch: recording.fetch }),
  };
  const code =
    id === "openrouter"
      ? await smokeOpenRouter({
          ...common,
          ...(endpoint === undefined ? {} : { endpoint }),
          ...(o.nowMs === undefined ? {} : { now: o.nowMs }),
        })
      : id === "google"
        ? await geminiSmokeCommand(common)
        : await smokeCommand({ ...common, ...(id === "anthropic" ? {} : { provider: id }) });
  if (recording !== null && dir !== undefined) {
    const n = await recording.done();
    io.out(
      n === 0
        ? `nothing recorded: ${dir} was not created\n`
        : `recorded ${n} exchange(s), sanitised, in ${dir}\n`,
    );
  }
  return code;
}

function dispatch(
  command: string,
  argv: readonly string[],
  io: CliIo,
  env: ArenaEnv,
  o: MainOptions,
): Promise<number> | number {
  const profilesDir = o.profilesDir ?? PROFILES_DIR;
  switch (command) {
    case "run":
      return runCommand(argv, io, env, o.signals, o.nowMs ?? Date.now, profilesDir);
    case "estimate":
      return estimateCommand(argv, io, env, o.nowMs ?? Date.now, profilesDir);
    case "reconcile":
      return reconcileCommand(argv, io, (o.nowMs ?? Date.now)());
    case "calibrate":
      return calibrateCommand(argv, io, profilesDir);
    case "series":
      return seriesCommand(argv, io, env, o.signals, o.nowMs ?? Date.now, profilesDir);
    case "cost": {
      const f = parseFlags(argv, COST_FLAGS, COST_USAGE, { min: 1, max: 1, name: "run" });
      io.out(
        formatCost(readCalls(f.positionals[0] ?? ""), {
          reprice: f.bool("reprice"),
          at: new Date((o.nowMs ?? Date.now)()).toISOString(),
        }),
      );
      return EXIT.ok;
    }
    case "personalities":
      parseFlags(argv, {}, PERSONALITIES_USAGE, { min: 0, max: 0, name: "positional" });
      return personalities(io);
    case "smoke":
      return smoke(argv, io, env, o);
    default:
      throw new UsageError(`unknown command "${command}"\n\n${USAGE}`);
  }
}

const COMMAND_USAGE: Readonly<Record<string, string>> = {
  run: RUN_USAGE,
  estimate: ESTIMATE_USAGE,
  reconcile: RECONCILE_USAGE,
  calibrate: CALIBRATE_USAGE,
  series: SERIES_USAGE,
  cost: COST_USAGE,
  personalities: PERSONALITIES_USAGE,
  smoke: SMOKE_USAGE,
};

/** Runs one `arena` command line; returns its exit code. Never throws. */
export async function main(
  argv: readonly string[],
  io: CliIo,
  env: Readonly<Record<string, string | undefined>>,
  o: MainOptions = {},
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
    return await dispatch(command, rest, io, arenaEnv(env), o);
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

/** The signals `arena run` takes over: an interrupt, a termination, a closed terminal or session. */
export const OPERATOR_SIGNALS: readonly NodeJS.Signals[] = Object.freeze([
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
]);

/**
 * SIGINT, SIGTERM and SIGHUP for `arena run` (subscribed before its start preflight): the first two
 * go to the run (hand off, then abort); a third is handed to the run (it writes an `operator` line)
 * and then exits at once (code 130), whatever the run is doing.
 */
export function processSignalsOf(exit: (code: number) => void = (c) => process.exit(c)) {
  const source: SignalSource = {
    subscribe(handler) {
      let count = 0;
      const on = (signal: NodeJS.Signals): void => {
        count += 1;
        try {
          handler(signal);
        } finally {
          if (count >= 3) exit(130);
        }
      };
      for (const s of OPERATOR_SIGNALS) process.on(s, on);
      return () => {
        for (const s of OPERATOR_SIGNALS) process.off(s, on);
      };
    },
  };
  return source;
}

export const processSignals: SignalSource = processSignalsOf();

if (import.meta.main) {
  const code = await main(
    process.argv.slice(2),
    {
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    },
    process.env,
    { signals: processSignals },
  );
  // A real-time abort can leave a bot's think-time timer behind: exit once the run is reported.
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}
