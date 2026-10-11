import {
  BOT_STRATEGIES,
  botFromLabel,
  botLabel,
  parseBotLabel,
  withThinkTime,
  type BotStrategy,
} from "@perfidia/bots";
import { RULESETS, findRuleset, getRuleset, type AnyRuleset } from "@perfidia/engine";
import { DAY, idKeyFromSeed } from "@perfidia/engine/core";
import {
  MemorySink,
  runMatch,
  type Handoff,
  type LogSink,
  type RunMatchOptions,
  type RunResult,
  type VirtualTime,
  type WallSource,
} from "@perfidia/gateway";
import {
  PlayerIdSchema,
  type HeaderLine,
  type Json,
  type LogLine,
  type MatchSetup,
  type PlayerId,
  type SeatAgent,
  type TimeSource,
} from "@perfidia/protocol";
import { SystemTime, createVirtualTime, systemWall } from "./time.ts";

// Running matches with bots through the gateway (docs/architecture.md §12.1): setups with the
// seed-derived id key by default, the four bots cycled over the seats, the clock choices, and
// `optionsFromHeader`, which rebuilds a run's options from its log for Level G (bots from the
// header's controller labels, `controller` lines as hand-offs, the clock spec and latency model).
// The CLI, the integration test, the hardening, golden and exit tests all run matches through here.

/** The four bots, in the order `--bots` cycles them by default. */
export const DEFAULT_BOTS: readonly BotStrategy[] = BOT_STRATEGIES;

export interface SetupSpec {
  readonly seed: number;
  readonly players: number;
  readonly overrides?: Readonly<Record<string, Json>>;
  /** Sugar for `time.matchEnd = days · 86400` (§3.6); an explicit override wins. */
  readonly days?: number;
  /** Default `idKeyFromSeed(seed)`: reproducible, not secret (§4.1). */
  readonly idKey?: string;
}

/** The setup of a match of `ruleset`: seats `p1..pN`, the exact ref, the seed-derived id key by default. */
export function setupFor(ruleset: AnyRuleset, spec: SetupSpec): MatchSetup {
  const overrides: Record<string, Json> = {};
  if (spec.days !== undefined) overrides["time.matchEnd"] = spec.days * DAY;
  Object.assign(overrides, spec.overrides);
  return {
    ruleset: ruleset.ref,
    overrides,
    seed: spec.seed,
    idKey: spec.idKey ?? idKeyFromSeed(spec.seed),
    seats: Array.from({ length: spec.players }, (_, i) => ({
      id: PlayerIdSchema.parse(`p${i + 1}`),
    })),
  };
}

/** Think time for bots in real time: a latency range on the run's time source (§9.4). */
export interface ThinkTime {
  readonly time: TimeSource;
  readonly latencyMs: readonly [number, number];
}

/** A bot from its label (`bot:<strategy>@<n>`), with think time when given; throws for an unknown label. */
export function agentFromLabel(
  label: string,
  seat: PlayerId,
  seed: number,
  think?: ThinkTime,
): SeatAgent {
  const bot = botFromLabel(label, { seat, seed });
  if (bot === null) throw new Error(`no bot named ${label} in this build`);
  return think === undefined
    ? bot
    : withThinkTime(bot, { time: think.time, latencyMs: think.latencyMs, seed });
}

/**
 * One bot per seat: `strategies` cycled over the seats (default the four bots), except the seats
 * `bySeat` names (`--seat p3=rusher`).
 */
export function botAgents(
  setup: MatchSetup,
  strategies: readonly BotStrategy[] = DEFAULT_BOTS,
  think?: ThinkTime,
  bySeat: Readonly<Record<string, BotStrategy>> = {},
): Map<PlayerId, SeatAgent> {
  if (strategies.length === 0) throw new Error("botAgents: no strategy");
  for (const seat of Object.keys(bySeat)) {
    if (!setup.seats.some((s) => s.id === seat))
      throw new Error(`botAgents: ${seat} is not a seat`);
  }
  return new Map(
    setup.seats.map((s, i): [PlayerId, SeatAgent] => {
      const strategy =
        (Object.hasOwn(bySeat, s.id) ? bySeat[s.id] : undefined) ??
        strategies[i % strategies.length] ??
        "expander";
      return [s.id, agentFromLabel(botLabel(strategy), s.id, setup.seed, think)];
    }),
  );
}

/** Run options without the sink, and the virtual time that must drive the run (if any). */
export interface PreparedRun {
  readonly options: Omit<RunMatchOptions, "sink">;
  readonly virtual: VirtualTime | null;
}

/** The clock of a bot run: lockstep, real time under `VirtualTime`, or real time on the system clock. */
export type ClockChoice =
  | { readonly kind: "lockstep"; readonly maxTurnsPerSecond?: number }
  | {
      readonly kind: "virtual";
      /** Default 3 game-seconds per wall-second. */
      readonly speed?: { readonly num: number; readonly den: number };
      /** Default [2000, 60000] (§13.5). */
      readonly latencyMs?: readonly [number, number];
    }
  | {
      readonly kind: "system";
      readonly speed: { readonly num: number; readonly den: number };
      readonly latencyMs?: readonly [number, number];
    };

export interface BotRunSpec extends SetupSpec {
  /** A ruleset, or a ref or id resolved through the registry. */
  readonly ruleset: AnyRuleset | string;
  /** Cycled over the seats (default the four bots). */
  readonly bots?: readonly BotStrategy[];
  /** Strategies of particular seats, overriding `bots` for them. */
  readonly seatBots?: Readonly<Record<string, BotStrategy>>;
  readonly clock: ClockChoice;
  readonly handoffs?: readonly {
    readonly seat: PlayerId;
    readonly at: number;
    readonly strategy: BotStrategy;
  }[];
  readonly invariants?: RunMatchOptions["invariants"];
  readonly strict?: boolean;
  readonly snapshotEvery?: number;
}

/** Default think time of real-time bot runs (§13.5: latency 2–60 s). */
export const DEFAULT_LATENCY_MS: readonly [number, number] = [2000, 60000];

/** The run options of a bot match. */
export function prepareBotRun(spec: BotRunSpec): PreparedRun {
  const ruleset = typeof spec.ruleset === "string" ? getRuleset(spec.ruleset) : spec.ruleset;
  const setup = setupFor(ruleset, spec);
  const c = spec.clock;
  let virtual: VirtualTime | null = null;
  let clock: RunMatchOptions["clock"];
  let think: ThinkTime | undefined;
  let wall: WallSource | undefined;
  if (c.kind === "lockstep") {
    clock = {
      kind: "lockstep",
      ...(c.maxTurnsPerSecond === undefined ? {} : { maxTurnsPerSecond: c.maxTurnsPerSecond }),
    };
  } else if (c.kind === "virtual") {
    virtual = createVirtualTime();
    const latencyMs = c.latencyMs ?? DEFAULT_LATENCY_MS;
    think = { time: virtual, latencyMs };
    clock = {
      kind: "realtime",
      speed: c.speed ?? { num: 3, den: 1 },
      time: virtual,
      timeKind: "virtual",
      latencyMs,
    };
  } else {
    const time = new SystemTime();
    think = c.latencyMs === undefined ? undefined : { time, latencyMs: c.latencyMs };
    clock = {
      kind: "realtime",
      speed: c.speed,
      time,
      timeKind: "system",
      ...(c.latencyMs === undefined ? {} : { latencyMs: c.latencyMs }),
    };
    wall = systemWall;
  }
  const agents = botAgents(setup, spec.bots ?? DEFAULT_BOTS, think, spec.seatBots);
  const handoffs: Handoff[] = (spec.handoffs ?? []).map((h) => {
    const label = botLabel(h.strategy);
    return {
      seat: h.seat,
      at: h.at,
      label,
      agent: agentFromLabel(label, h.seat, setup.seed, think),
    };
  });
  return {
    options: {
      setup,
      ruleset,
      agents,
      clock,
      ...(handoffs.length === 0 ? {} : { handoffs }),
      ...(wall === undefined ? {} : { wall }),
      ...(spec.invariants === undefined ? {} : { invariants: spec.invariants }),
      ...(spec.strict === undefined ? {} : { strict: spec.strict }),
      ...(spec.snapshotEvery === undefined ? {} : { snapshotEvery: spec.snapshotEvery }),
    },
    virtual,
  };
}

/** Runs prepared options into `sink`, driving their virtual time when they have one. */
export function runPrepared(p: PreparedRun, sink: LogSink): Promise<RunResult> {
  const run = (): Promise<RunResult> => runMatch({ ...p.options, sink });
  return p.virtual === null ? run() : p.virtual.run(run);
}

export interface BotRun {
  readonly run: RunResult;
  readonly sink: MemorySink;
  /** The log, parsed and validated. */
  readonly lines: LogLine[];
}

/** Runs a bot match in memory. */
export async function runBots(spec: BotRunSpec): Promise<BotRun> {
  const sink = new MemorySink();
  const run = await runPrepared(prepareBotRun(spec), sink);
  return { run, sink, lines: sink.parsed() };
}

/** Why a log cannot be re-simulated (Level G), or null when it can. */
export function resimProblem(header: HeaderLine, lines: readonly LogLine[]): string | null {
  if (header.clock.kind === "realtime" && header.clock.time === "system") {
    return "a system-clock run is not reproducible (Level G covers lockstep and virtual-time runs)";
  }
  const labels = [
    ...Object.values(header.controllers),
    ...lines.flatMap((l) => (l.k === "controller" ? [l.label] : [])),
  ];
  const unknown = labels.find((label) => parseBotLabel(label) === null);
  return unknown === undefined ? null : `controller ${unknown} is not a bot of this build`;
}

/**
 * The run options that re-simulate a logged match (§10.4 Level G): the header's setup and ruleset
 * (through `rulesets`, the registry by default), bots from its controller labels and the
 * `controller` lines as hand-offs, its clock spec and latency model. Throws when the log cannot be
 * re-simulated (`resimProblem`).
 */
export function optionsFromHeader(
  header: HeaderLine,
  lines: readonly LogLine[],
  o: { readonly rulesets?: readonly AnyRuleset[] } = {},
): PreparedRun {
  const problem = resimProblem(header, lines);
  if (problem !== null) throw new Error(problem);
  const setup = header.setup;
  const ruleset = findRuleset(setup.ruleset, o.rulesets ?? RULESETS);
  if (ruleset === undefined || ruleset.ref !== setup.ruleset) {
    throw new Error(`the log's ruleset ${setup.ruleset} is not in this build`);
  }
  const c = header.clock;
  let virtual: VirtualTime | null = null;
  let clock: RunMatchOptions["clock"];
  let think: ThinkTime | undefined;
  if (c.kind === "lockstep") {
    if (c.roundTimeoutMs !== undefined) virtual = createVirtualTime();
    clock = {
      kind: "lockstep",
      maxTurnsPerSecond: c.maxTurnsPerSecond,
      ...(c.roundTimeoutMs === undefined || virtual === null
        ? {}
        : { roundTimeoutMs: c.roundTimeoutMs, time: virtual }),
    };
  } else {
    virtual = createVirtualTime();
    if (c.latencyMs !== undefined) think = { time: virtual, latencyMs: c.latencyMs };
    clock = {
      kind: "realtime",
      speed: { num: c.speed[0], den: c.speed[1] },
      time: virtual,
      timeKind: "virtual",
      ...(c.latencyMs === undefined ? {} : { latencyMs: c.latencyMs }),
      ...(c.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: c.turnTimeoutMs }),
    };
  }
  const agents = new Map(
    setup.seats.map((s): [PlayerId, SeatAgent] => {
      const label = header.controllers[s.id];
      if (label === undefined) throw new Error(`the header has no controller for ${s.id}`);
      return [s.id, agentFromLabel(label, s.id, setup.seed, think)];
    }),
  );
  const handoffs: Handoff[] = lines.flatMap((l) =>
    l.k === "controller"
      ? [
          {
            seat: l.seat,
            at: l.t,
            label: l.label,
            agent: agentFromLabel(l.label, l.seat, setup.seed, think),
          },
        ]
      : [],
  );
  return {
    options: { setup, ruleset, agents, clock, ...(handoffs.length === 0 ? {} : { handoffs }) },
    virtual,
  };
}

/** Re-simulates a logged match in memory (Level G), with the given extra options. */
export async function resimulate(
  lines: readonly LogLine[],
  o: {
    readonly rulesets?: readonly AnyRuleset[];
    readonly invariants?: RunMatchOptions["invariants"];
  } = {},
): Promise<BotRun> {
  const header = lines[0];
  if (header?.k !== "header") throw new Error("a log starts with its header line");
  const prepared = optionsFromHeader(
    header,
    lines,
    o.rulesets === undefined ? {} : { rulesets: o.rulesets },
  );
  const sink = new MemorySink();
  const options =
    o.invariants === undefined
      ? prepared.options
      : { ...prepared.options, invariants: o.invariants };
  const run = await runPrepared({ options, virtual: prepared.virtual }, sink);
  return { run, sink, lines: sink.parsed() };
}
