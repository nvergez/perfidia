import { BOT_STRATEGIES, isBotStrategy, type BotStrategy } from "@perfidia/bots";
import {
  MatchConfigError,
  UnknownRuleset,
  createMatch,
  getRuleset,
  parseOverride,
  resolveConfig,
  type AnyRuleset,
  type InvariantLevel,
} from "@perfidia/engine";
import { DAY, idKeyFromSeed } from "@perfidia/engine/core";
import { IdKeySchema, type Json, type MatchSetup } from "@perfidia/protocol";
import { UsageError } from "../args.ts";
import { DEFAULT_BOTS, setupFor, type ClockChoice } from "../harness/index.ts";

// The plan of a `sim run` (docs/architecture.md §12.1, §3.6): the ruleset from the registry (a test
// ruleset only with `--allow-test`), the overrides validated by the ruleset's schema and the config
// checks, N within the ruleset's player range, the seed-derived id key by default (or a random
// one), the bots cycled over the seats with per-seat choices, and the clock. Every check runs
// before anything is written, so a bad command line leaves no run directory behind.

/** The default ruleset of `run`: the latest published `perfidia-1`. */
export const DEFAULT_RULESET = "perfidia-1";
export const DEFAULT_SEED = 1;
export const DEFAULT_SPEED = { num: 3, den: 1 } as const;
export const DEFAULT_VIRTUAL_LATENCY_MS: readonly [number, number] = [2000, 60000];
export const INVARIANT_LEVELS: readonly InvariantLevel[] = ["off", "checkpoint", "step"];

/** What a `run` command line asks for, its values parsed but not yet checked against a ruleset. */
export interface RunRequest {
  readonly ruleset?: string | undefined;
  /** `key.path=value` texts. */
  readonly overrides?: readonly string[] | undefined;
  readonly seed?: number | undefined;
  readonly players?: number | undefined;
  readonly days?: number | undefined;
  /** 32 lowercase hex characters, or `random`. */
  readonly idKey?: string | undefined;
  readonly bots?: readonly string[] | undefined;
  /** `p3=rusher` texts. */
  readonly seats?: readonly string[] | undefined;
  readonly clock?: string | undefined;
  readonly time?: string | undefined;
  readonly speed?: { readonly num: number; readonly den: number } | undefined;
  readonly latencyMs?: readonly [number, number] | undefined;
  readonly invariants?: string | undefined;
  readonly snapshotEvery?: number | undefined;
  readonly traceHashes?: boolean | undefined;
  readonly allowTest?: boolean | undefined;
}

export interface RunPlan {
  readonly ruleset: AnyRuleset;
  readonly setup: MatchSetup;
  readonly bots: readonly BotStrategy[];
  readonly seatBots: Readonly<Record<string, BotStrategy>>;
  readonly clock: ClockChoice;
  readonly invariants: InvariantLevel;
  readonly snapshotEvery: number;
  readonly traceHashes: boolean;
}

/** A fresh 128-bit id key from the platform's CSPRNG (§4.1: LLM matches need a secret key). */
export function randomIdKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A ruleset from the registry; an unknown ref or id is a usage error listing the refs. */
export function rulesetFor(refOrId: string, allowTest: boolean): AnyRuleset {
  let rs: AnyRuleset;
  try {
    rs = getRuleset(refOrId);
  } catch (error) {
    if (error instanceof UnknownRuleset) throw new UsageError(error.message);
    throw error;
  }
  if (rs.status === "test" && !allowTest) {
    throw new UsageError(
      `${rs.ref} is a test ruleset (status "test"), not a game: pass --allow-test to run it anyway`,
    );
  }
  return rs;
}

/** The overrides of `key.path=value` texts, plus `--days` as `time.matchEnd` (§3.6). */
export function overridesFrom(
  texts: readonly string[],
  days: number | undefined,
): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const text of texts) {
    const o = parseOverride(text);
    if ("error" in o) throw new UsageError(o.error);
    if (Object.hasOwn(out, o.path)) throw new UsageError(`--override ${o.path} is given twice`);
    out[o.path] = o.value;
  }
  if (days !== undefined) {
    if (Object.hasOwn(out, "time.matchEnd")) {
      throw new UsageError(
        "--days and --override time.matchEnd both set the match length: keep one",
      );
    }
    out["time.matchEnd"] = days * DAY;
  }
  return out;
}

/**
 * The effective config of `overrides` on `rs` (§3.6: schema and compile checks); throws one usage
 * error listing every config issue with its path.
 */
export function checkOverrides(
  rs: AnyRuleset,
  overrides: Readonly<Record<string, Json>>,
  what = "",
): unknown {
  const resolved = resolveConfig(rs, overrides);
  if (resolved.ok) return resolved.config;
  const list = resolved.errors.map((i) => `  ${i.path === "" ? "(config)" : i.path}: ${i.message}`);
  throw new UsageError(`invalid config for ${rs.ref}${what}:\n${list.join("\n")}`);
}

/** The ruleset's player range under `config`. */
export function playerRange(rs: AnyRuleset, config: unknown): { min: number; max: number } {
  return rs.players(config);
}

/** `--bots`: strategies, comma-separated, each a bot of this build. */
export function parseBots(texts: readonly string[]): BotStrategy[] {
  const out: BotStrategy[] = [];
  for (const name of texts.flatMap((t) => t.split(","))) {
    const s = name.trim();
    if (!isBotStrategy(s)) {
      throw new UsageError(`unknown bot "${s}"; the bots are ${BOT_STRATEGIES.join(", ")}`);
    }
    out.push(s);
  }
  if (out.length === 0)
    throw new UsageError(`--bots lists no bot; the bots are ${BOT_STRATEGIES.join(", ")}`);
  return out;
}

/** `--seat p3=rusher` texts, checked against the seats p1..pN. */
export function parseSeatBots(
  texts: readonly string[],
  players: number,
): Record<string, BotStrategy> {
  const out: Record<string, BotStrategy> = {};
  for (const text of texts) {
    const m = /^(p[1-9][0-9]*)=([a-z]+)$/.exec(text);
    if (m?.[1] === undefined || m[2] === undefined) {
      throw new UsageError(`--seat ${text}: write seat=bot, such as p3=rusher`);
    }
    const seat = m[1];
    const bot = m[2];
    if (Number(seat.slice(1)) > players) {
      throw new UsageError(`--seat ${text}: the match has seats p1..p${players}`);
    }
    if (!isBotStrategy(bot)) {
      throw new UsageError(
        `--seat ${text}: unknown bot "${bot}"; the bots are ${BOT_STRATEGIES.join(", ")}`,
      );
    }
    if (Object.hasOwn(out, seat)) throw new UsageError(`--seat ${seat} is given twice`);
    out[seat] = bot;
  }
  return out;
}

/** The clock of the request: lockstep, or real time on the virtual or system clock. */
export function clockFor(req: RunRequest): ClockChoice {
  const kind = req.clock ?? "lockstep";
  if (kind !== "lockstep" && kind !== "realtime") {
    throw new UsageError(`--clock must be lockstep or realtime, got "${kind}"`);
  }
  if (kind === "lockstep") {
    for (const [flag, v] of [
      ["--time", req.time],
      ["--speed", req.speed],
      ["--latency", req.latencyMs],
    ] as const) {
      if (v !== undefined) throw new UsageError(`${flag} applies to --clock realtime only`);
    }
    return { kind: "lockstep" };
  }
  const time = req.time ?? "virtual";
  if (time !== "virtual" && time !== "system") {
    throw new UsageError(`--time must be virtual or system, got "${time}"`);
  }
  const speed = req.speed ?? DEFAULT_SPEED;
  if (time === "virtual") {
    return { kind: "virtual", speed, latencyMs: req.latencyMs ?? DEFAULT_VIRTUAL_LATENCY_MS };
  }
  return {
    kind: "system",
    speed,
    ...(req.latencyMs === undefined ? {} : { latencyMs: req.latencyMs }),
  };
}

/**
 * Creates the match of `setup` once and drops it, so the creation checks of §3.6 (which may depend
 * on the seed's world) run before anything is written; a `MatchConfigError` becomes a `UsageError`
 * listing its issues, `what` naming the match.
 */
export function checkCreation(setup: MatchSetup, ruleset: AnyRuleset, what = ""): void {
  try {
    createMatch(setup, ruleset, { invariants: "checkpoint" });
  } catch (error) {
    if (error instanceof MatchConfigError) {
      const list = error.issues.map((i) => `  ${i.path === "" ? "(setup)" : i.path}: ${i.message}`);
      throw new UsageError(`the match${what} cannot be created:\n${list.join("\n")}`);
    }
    throw error;
  }
}

/**
 * Checks a run request completely and returns its plan; throws `UsageError` (exit 3) on anything
 * wrong, naming the flag, the config path, the player range or the refs of the build. The match is
 * created once here, so the creation checks of §3.6 also run before any file is written.
 */
export function planRun(req: RunRequest, o: { readonly randomKey?: () => string } = {}): RunPlan {
  const ruleset = rulesetFor(req.ruleset ?? DEFAULT_RULESET, req.allowTest ?? false);
  const overrides = overridesFrom(req.overrides ?? [], req.days);
  const config = checkOverrides(ruleset, overrides);
  const range = playerRange(ruleset, config);
  const players = req.players ?? range.min;
  if (players < range.min || players > range.max) {
    throw new UsageError(
      `--players ${players} is outside the player range of ${ruleset.ref}: ${range.min}..${range.max}`,
    );
  }
  const seed = req.seed ?? DEFAULT_SEED;
  let idKey: string;
  if (req.idKey === undefined) idKey = idKeyFromSeed(seed);
  else if (req.idKey === "random") idKey = (o.randomKey ?? randomIdKey)();
  else {
    const parsed = IdKeySchema.safeParse(req.idKey);
    if (!parsed.success) {
      throw new UsageError(
        `--id-key must be 32 lowercase hex characters or "random", got "${req.idKey}"`,
      );
    }
    idKey = parsed.data;
  }
  const invariants = req.invariants ?? "checkpoint";
  const level = INVARIANT_LEVELS.find((l) => l === invariants);
  if (level === undefined) {
    throw new UsageError(
      `--invariants must be one of ${INVARIANT_LEVELS.join(", ")}, got "${invariants}"`,
    );
  }
  const bots = req.bots === undefined ? [...DEFAULT_BOTS] : parseBots(req.bots);
  const seatBots = parseSeatBots(req.seats ?? [], players);
  const clock = clockFor(req);
  const setup = setupFor(ruleset, { seed, players, overrides, idKey });
  checkCreation(setup, ruleset);
  return {
    ruleset,
    setup,
    bots,
    seatBots,
    clock,
    invariants: level,
    snapshotEvery: req.snapshotEvery ?? 24,
    traceHashes: req.traceHashes ?? false,
  };
}
