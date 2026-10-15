import { createMatch, type AnyRuleset } from "@perfidia/engine";
import { EngineBug, MatchConfigError, type InvariantLevel } from "@perfidia/engine/kernel";
import {
  AgentRoundError,
  createLockstepDriver,
  createRealtimeDriver,
  describeError,
  type ClockDriver,
} from "@perfidia/gateway/clock";
import type { GatewayState } from "@perfidia/gateway/seat";
import type {
  ClockSpec,
  Hash64,
  MatchResult,
  MatchSetup,
  PlayerId,
  SeatAgent,
  TimeSource,
} from "@perfidia/protocol";
import {
  MatchHost,
  type Handoff,
  type HandoffQueue,
  type WakeCounts,
  type WallSource,
} from "./host.ts";
import type { LogSink } from "./sink.ts";
import { copyOf, type ToolRegistry } from "./tools.ts";

// `runMatch` (docs/architecture.md §8.7): creates the match, runs it under the chosen clock with a
// `MatchHost`, and returns the result, the final hash, the statistics and a copy of the final
// gateway state (for the rebuild test of §10.5). A `MatchConfigError` is thrown before the header
// is written; an engine error, a driver error or (strict) an agent error or `INTERNAL` writes a
// `fatal` line, flushes and rethrows.

export interface RunMatchOptions {
  readonly setup: MatchSetup;
  /** Resolved by the caller through the registry; must equal `setup.ruleset`. */
  readonly ruleset: AnyRuleset;
  readonly agents: ReadonlyMap<PlayerId, SeatAgent>;
  readonly clock:
    | {
        readonly kind: "lockstep";
        /** Default 3. */
        readonly maxTurnsPerSecond?: number;
        /** Optional; needs `time`; recorded in the header. */
        readonly roundTimeoutMs?: number;
        readonly time?: TimeSource;
      }
    | {
        readonly kind: "realtime";
        readonly speed: { readonly num: number; readonly den: number };
        readonly time: TimeSource;
        /** Recorded in the header. */
        readonly timeKind: "virtual" | "system";
        /** The agents' think-time range, recorded for Level G (the caller wraps the agents). */
        readonly latencyMs?: readonly [number, number];
        readonly turnTimeoutMs?: number;
      };
  readonly sink: LogSink;
  /** A seat handed to another controller; applied when its first turn at or after `at` opens. */
  readonly handoffs?: readonly Handoff[];
  /** Hand-offs decided while the match runs (e.g. an LLM seat over budget); polled after `handoffs`. */
  readonly handoffQueue?: HandoffQueue;
  /** Injected by `sim` (system time); absent in tests: no `wall*` keys. */
  readonly wall?: WallSource;
  /** Default `checkpoint`. */
  readonly invariants?: InvariantLevel;
  /** Game hours between snapshots; default 24; 0 = the final one only. */
  readonly snapshotEvery?: number;
  /** Agent errors and `INTERNAL` are fatal (tests). */
  readonly strict?: boolean;
  /** Tool registry doubles for tests (default: the ruleset's). */
  readonly tools?: ToolRegistry;
}

export interface RunStats {
  turns: number;
  /** Calls received from agents, rejected ones included. */
  calls: number;
  engineEvents: number;
  /** Per seat, per game day. */
  wakes: Record<PlayerId, WakeCounts[]>;
  /** Real time only: the largest delay of the loop behind its deadline, in ms of `time`. */
  lagMaxMs: number;
}

export interface RunResult {
  readonly result: MatchResult;
  readonly finalHash: Hash64;
  readonly stats: RunStats;
  /** A copy of the final live gateway state (§10.5). */
  readonly gateway: GatewayState;
}

/** The clock spec the header records. */
function clockSpec(clock: RunMatchOptions["clock"]): ClockSpec {
  if (clock.kind === "lockstep") {
    return {
      kind: "lockstep",
      maxTurnsPerSecond: clock.maxTurnsPerSecond ?? 3,
      ...(clock.roundTimeoutMs === undefined ? {} : { roundTimeoutMs: clock.roundTimeoutMs }),
    };
  }
  return {
    kind: "realtime",
    speed: [clock.speed.num, clock.speed.den],
    time: clock.timeKind,
    ...(clock.latencyMs === undefined
      ? {}
      : { latencyMs: [clock.latencyMs[0], clock.latencyMs[1]] }),
    ...(clock.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: clock.turnTimeoutMs }),
  };
}

function driverOf(o: RunMatchOptions): ClockDriver & { stats?(): { lagMaxMs: number } } {
  const strict = o.strict ?? false;
  const c = o.clock;
  if (c.kind === "lockstep") {
    return createLockstepDriver({
      ...(c.maxTurnsPerSecond === undefined ? {} : { maxTurnsPerSecond: c.maxTurnsPerSecond }),
      ...(c.roundTimeoutMs === undefined ? {} : { roundTimeoutMs: c.roundTimeoutMs }),
      ...(c.time === undefined ? {} : { time: c.time }),
      strict,
    });
  }
  return createRealtimeDriver({
    speed: c.speed,
    time: c.time,
    ...(c.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: c.turnTimeoutMs }),
    strict,
  });
}

/**
 * The `fatal` line's kind for an error that stopped the match (§10.2): the engine's own kind, an
 * agent's failure in strict mode, else `driver` (a clock or host failure, `EngineMisuse`, and a
 * strict-mode `INTERNAL`, which is the gateway's).
 */
function fatalKind(error: unknown): "invariant" | "engine" | "driver" | "agent" {
  if (error instanceof EngineBug) return error.kind;
  if (error instanceof AgentRoundError) return "agent";
  return "driver";
}

/** Runs a match to its end (§8.7). */
export async function runMatch(o: RunMatchOptions): Promise<RunResult> {
  if (o.setup.ruleset !== o.ruleset.ref) {
    throw new MatchConfigError([
      {
        path: "setup.ruleset",
        message: `the setup names ${o.setup.ruleset}, the ruleset is ${o.ruleset.ref}`,
      },
    ]);
  }
  const match = createMatch(o.setup, o.ruleset, { invariants: o.invariants ?? "checkpoint" });
  const agents = new Map(o.agents);
  const host = new MatchHost({
    match,
    sink: o.sink,
    agents,
    clock: clockSpec(o.clock),
    ...(o.handoffs === undefined ? {} : { handoffs: o.handoffs }),
    ...(o.handoffQueue === undefined ? {} : { handoffQueue: o.handoffQueue }),
    ...(o.wall === undefined ? {} : { wall: o.wall }),
    ...(o.snapshotEvery === undefined ? {} : { snapshotEvery: o.snapshotEvery }),
    ...(o.strict === undefined ? {} : { strict: o.strict }),
    ...(o.tools === undefined ? {} : { tools: o.tools }),
  });
  const driver = driverOf(o);
  let result: MatchResult;
  try {
    result = await driver.run(host, agents);
  } catch (error) {
    host.fatal(error, fatalKind(error), describeError(error));
    throw error;
  }
  const counts = host.stats();
  return {
    result,
    finalHash: match.hash(),
    stats: { ...counts, lagMaxMs: driver.stats?.().lagMaxMs ?? 0 },
    gateway: copyOf<GatewayState>(host.gw),
  };
}
