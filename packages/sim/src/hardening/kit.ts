import {
  findRuleset,
  loadMatch,
  verifyLog,
  type AnyRuleset,
  type ReplayReport,
} from "@perfidia/engine";
import { canonicalJson } from "@perfidia/engine/core";
import { HOUR, stateHash, type InvariantLevel, type Match } from "@perfidia/engine/kernel";
import {
  copyOf,
  createToolRegistry,
  createWakeScheduler,
  deliver,
  gatewayRulesCopy,
  invokeTool,
  rebuildGatewayState,
  type GatewayState,
  type ToolEnv,
  type ToolRegistry,
  type WakeScheduler,
} from "@perfidia/gateway";
import type {
  GameState,
  GameTime,
  LogLine,
  PlayerId,
  Snapshot,
  ToolCall,
  ToolResult,
} from "@perfidia/protocol";
import { runBots, type BotRun, type BotRunSpec, type ClockChoice } from "../harness/index.ts";

// Shared helpers of the cross-ruleset hardening tests (docs/architecture.md §13.2, §13.4, §15 T16):
// 1-game-day bot runs of both rulesets through the harness, Level E, states taken from a run's
// snapshots and edited as plain JSON, the gateway state at a checkpoint (rebuilt from the log), and
// a tool session that calls a seat's tools on a match outside any turn, as the host would.

/** The rulesets every hardening property runs on: both perfidia-1 versions and sandbox-1. */
export const REFS = ["perfidia-1@1.0.0", "perfidia-1@1.1.0", "sandbox-1@1.0.0"] as const;
export type Ref = (typeof REFS)[number];

export const LOCKSTEP: ClockChoice = { kind: "lockstep" };
export const VIRTUAL: ClockChoice = { kind: "virtual" };

/** The registry's resolver. */
export const resolve = (ref: string): AnyRuleset | undefined => findRuleset(ref);

/** The descriptor of a published or test ref. */
export function rulesetOf(ref: Ref): AnyRuleset {
  const r = findRuleset(ref);
  if (r === undefined) throw new Error(`no ruleset ${ref}`);
  return r;
}

/** A 1-game-day match of the default bots (strict), `players` seats. */
export function daySpec(
  ref: string,
  clock: ClockChoice,
  seed: number,
  extra: Partial<BotRunSpec> = {},
): BotRunSpec {
  return { ruleset: ref, seed, players: 6, days: 1, clock, strict: true, ...extra };
}

const runs = new Map<string, Promise<BotRun>>();

/** Level E through the registry. */
export function levelE(
  lines: readonly LogLine[],
  opts: { invariants?: InvariantLevel } = {},
): ReplayReport {
  return verifyLog(lines, resolve, opts);
}

/** The run, once its whole log has passed Level E (§13.4: every log a test produces does). */
export function verified(run: BotRun): BotRun {
  const report = levelE(run.lines);
  if (!report.ok) {
    throw new Error(`the run's log fails Level E: ${canonicalJson(report.divergence ?? null)}`);
  }
  return run;
}

/**
 * `runBots(spec)`, run once per spec in this process (the runs are deterministic), its whole log
 * checked at Level E once.
 */
export function cachedRun(spec: BotRunSpec): Promise<BotRun> {
  const ruleset = typeof spec.ruleset === "string" ? spec.ruleset : spec.ruleset.ref;
  const key = canonicalJson({ ...spec, ruleset });
  let run = runs.get(key);
  if (run === undefined) {
    run = runBots(spec).then(verified);
    runs.set(key, run);
  }
  return run;
}

/** The run's snapshot of game hour `hour`. */
export function snapshotAt(run: BotRun, hour: number): Snapshot {
  const snap = run.sink.parsedSnapshots().find((s) => s.hour === hour && s.t === hour * HOUR);
  if (snap === undefined) throw new Error(`no snapshot of hour ${hour}`);
  return snap;
}

/** A copy of `snap` whose state `edit` changed in place, with its hash recomputed. */
export function editSnapshot(snap: Snapshot, edit: (state: GameState) => void): Snapshot {
  const copy = copyOf(snap);
  edit(copy.state);
  return { ...copy, hash: stateHash(copy.state) };
}

/** A match loaded from `snap`, checked against every step invariant. */
export function loadChecked(snap: Snapshot, invariants: InvariantLevel = "step"): Match {
  const ruleset = findRuleset(snap.setup.ruleset);
  if (ruleset === undefined) throw new Error(`no ruleset ${snap.setup.ruleset}`);
  const match = loadMatch(snap, ruleset, { invariants });
  match.checkInvariants("step");
  return match;
}

/**
 * The gateway state of the run at the checkpoint of hour `hour`: the log up to that `ckpt` line,
 * rebuilt (§10.5). Throws when the prefix does not fold.
 */
export function gatewayAt(lines: readonly LogLine[], hour: number): GatewayState {
  const i = lines.findIndex((l) => l.k === "ckpt" && l.hour === hour);
  if (i < 0) throw new Error(`no ckpt line of hour ${hour}`);
  const rebuilt = rebuildGatewayState(lines.slice(0, i + 1), resolve);
  if (rebuilt.drift !== null) throw new Error(`the log does not fold: ${rebuilt.drift.actual}`);
  if (rebuilt.report.divergence?.kind !== "end") {
    throw new Error(`the log prefix diverges: ${canonicalJson(rebuilt.report.divergence ?? null)}`);
  }
  return rebuilt.gw;
}

/**
 * A seat calling its tools on `match` at the current time, outside the turn rules (no caps on
 * rounds or calls), with the host's effects: engine actions applied and their events delivered to
 * the gateway state, notes written, self-wakes set.
 */
export class ToolSession {
  readonly match: Match;
  readonly gw: GatewayState;
  readonly seat: PlayerId;
  readonly wake: WakeScheduler;
  private readonly tools: ToolRegistry;
  private n = 0;

  constructor(match: Match, gw: GatewayState, seat: PlayerId) {
    this.match = match;
    this.gw = gw;
    this.seat = seat;
    this.wake = createWakeScheduler(gw, gatewayRulesCopy(match.rules.gateway));
    this.tools = createToolRegistry(match.ruleset);
  }

  call(c: ToolCall): ToolResult {
    const env: ToolEnv = {
      match: this.match,
      seat: this.seat,
      gw: this.gw,
      gatewayRules: this.wake.rules,
      turn: { index: 1, round: 0, call: this.n },
      submit: (a) => {
        const out = this.match.apply(this.seat, a);
        if (out.ok) deliver(this.gw, out.events, this.wake);
        return out;
      },
      rejectItem: () => undefined,
      note: () => undefined,
      endTurn: (wakeAt: GameTime | null) =>
        wakeAt === null ? null : this.wake.requestSelfWake(this.seat, wakeAt, this.match.now),
    };
    this.n += 1;
    return invokeTool(this.tools, env, c).result;
  }
}
