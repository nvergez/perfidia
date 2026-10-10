import { assertSafeInt, ceilDiv, floorDiv } from "@perfidia/engine/core";
import type {
  GameTime,
  MatchResult,
  PlayerId,
  SeatAgent,
  Sleep,
  TimeSource,
} from "@perfidia/protocol";
import { AgentRoundError, ClockError } from "./errors.ts";
import { playRound, type RoundTimeout } from "./round.ts";
import { Signal } from "./signal.ts";
import type { ClockDriver, ClockHost, TurnFailure, TurnHandle } from "./types.ts";

// The real-time driver (docs/architecture.md §9.3): game time follows wall time at `num/den`
// game-seconds per wall-second, seats play asynchronously, and an action takes effect at the game
// second when it is received. Wall time comes only from the injected `TimeSource`.

/** `num/den` game-seconds per wall-second. */
export interface Speed {
  readonly num: number;
  readonly den: number;
}

/** The game-to-wall mapping of one match, anchored at `wall0` (the wall time of `host.start()`). */
export interface SpeedMapping {
  readonly wall0: number;
  /** `min(endsAt, floor((ms − wall0) · num / (1000 · den)))`: the game second at wall time `ms`. */
  gameAt(ms: number): GameTime;
  /**
   * `wall0 + ceilDiv(g · 1000 · den, num)`: the first wall ms at which `gameAt` reaches `g`. When
   * the speed is at most 1000 (every game second lasts ≥ 1 ms), `gameAt(wallAt(g)) = g`; faster,
   * one ms spans several game seconds and `gameAt(wallAt(g))` may exceed `g`.
   */
  wallAt(g: GameTime): number;
}

function checkSpeed(speed: Speed): void {
  for (const [key, value] of [
    ["num", speed.num],
    ["den", speed.den],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ClockError(`real-time speed.${key} must be a positive integer, got ${value}`);
    }
  }
}

export function speedMapping(wall0: number, speed: Speed, endsAt: GameTime): SpeedMapping {
  assertSafeInt(wall0, "wall0");
  checkSpeed(speed);
  const { num, den } = speed;
  const msPerDen = assertSafeInt(1000 * den, "1000 · speed.den");
  return {
    wall0,
    gameAt(ms: number): GameTime {
      const elapsed = assertSafeInt(ms - wall0, "elapsed wall ms");
      return Math.min(endsAt, floorDiv(assertSafeInt(elapsed * num, "elapsed · num"), msPerDen));
    },
    wallAt(g: GameTime): number {
      return wall0 + ceilDiv(assertSafeInt(g * msPerDen, "g · 1000 · den"), num);
    },
  };
}

/** Rethrows the failure that stopped a run (a turn's host call or a strict agent error). */
function rethrow(failure: { readonly error: unknown }): never {
  throw failure.error;
}

export interface RealtimeOptions {
  readonly speed: Speed;
  readonly time: TimeSource;
  /** Bounds each round of a runaway agent, in ms of `time`; the timer is cancelled when the round answers. */
  readonly turnTimeoutMs?: number;
  /** Agent errors and timeouts are fatal (tests): the turn is closed, then `run` rejects. */
  readonly strict?: boolean;
}

export interface RealtimeStats {
  /** Main-loop iterations of the last run. */
  readonly iterations: number;
  /** Turns opened. */
  readonly turns: number;
  /** The largest delay between a sleep's deadline and the loop running again, in ms of `time`. */
  readonly lagMaxMs: number;
}

export interface RealtimeDriver extends ClockDriver {
  /** Counters of the current or last run. */
  stats(): RealtimeStats;
}

export function createRealtimeDriver(options: RealtimeOptions): RealtimeDriver {
  checkSpeed(options.speed);
  const { time, speed } = options;
  const turnTimeoutMs = options.turnTimeoutMs;
  if (turnTimeoutMs !== undefined && (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 1)) {
    throw new ClockError(
      `real-time turnTimeoutMs must be a positive integer, got ${turnTimeoutMs}`,
    );
  }
  const timeout: RoundTimeout | undefined =
    turnTimeoutMs === undefined ? undefined : { time, ms: turnTimeoutMs };
  const strict = options.strict ?? false;
  let stats = { iterations: 0, turns: 0, lagMaxMs: 0 };
  let running = false;

  async function playMatch(
    host: ClockHost,
    agents: ReadonlyMap<PlayerId, SeatAgent>,
  ): Promise<MatchResult> {
    const kick = new Signal();
    /** Seats whose turn this driver opened and has not closed yet. */
    const inTurn = new Set<PlayerId>();
    /** Turns not settled yet, closed or not. */
    const inflight = new Set<Promise<void>>();
    /** Round timeouts pending, cancelled if the run stops early. */
    const timers = new Set<Sleep>();
    let failure: { readonly error: unknown } | null = null;

    host.start();
    const mapping = speedMapping(time.nowMs(), speed, host.endsAt);
    // Game time stops when the match ends: `gameAt` stops at `endsAt`, and a match that ended
    // earlier (a win) is not stepped any more, so in-flight turns' calls land at the end time.
    const catchUp = (): void => {
      if (!host.ended()) host.advanceTo(Math.max(host.now(), mapping.gameAt(time.nowMs())));
    };

    const closeTurn = (h: TurnHandle, error?: string, cause?: TurnFailure): void => {
      if (error === undefined) h.close();
      else h.close(error, cause);
      inTurn.delete(h.seat);
      kick.notify();
    };

    const runTurn = async (seat: PlayerId): Promise<void> => {
      const h = host.openTurn(seat);
      while (!h.done) {
        // oxlint-disable-next-line no-await-in-loop -- a turn's rounds are sequential: each sees the previous results
        const r = await playRound(agents.get(seat), h.input(), timeout, timers);
        if (failure !== null) return;
        // The answer, or the failure, takes effect at the game second when it is received.
        catchUp();
        if (!r.ok) {
          closeTurn(h, r.error, r.cause);
          if (strict) throw new AgentRoundError(seat, r.cause, r.error);
          return;
        }
        h.execute(r.out);
        kick.notify();
      }
      closeTurn(h);
    };

    const startTurn = (seat: PlayerId): void => {
      inTurn.add(seat);
      stats.turns += 1;
      const turn: Promise<void> = runTurn(seat)
        .catch((e: unknown) => {
          failure ??= { error: e };
        })
        .finally(() => {
          inflight.delete(turn);
          kick.notify();
        });
      inflight.add(turn);
    };

    try {
      while (!host.ended()) {
        kick.clear();
        if (failure !== null) rethrow(failure);
        stats.iterations += 1;
        catchUp();
        if (host.ended()) break;
        for (const seat of host.dueSeats(host.now())) {
          if (!inTurn.has(seat)) startTurn(seat);
        }
        const next = host.nextTime();
        if (next === null && inflight.size === 0) {
          throw new ClockError(
            "host.nextTime() is null before the match ended, with no turn in flight",
          );
        }
        const target = next === null ? null : mapping.wallAt(Math.max(next, host.now() + 1));
        const sleep = target === null ? null : time.sleepUntil(target);
        const kicked = kick.wait();
        try {
          // oxlint-disable-next-line no-await-in-loop -- the loop sleeps until the next wake it knows of, or a kick
          await (sleep === null ? kicked.done : Promise.race([sleep.done, kicked.done]));
        } finally {
          sleep?.cancel();
          kicked.cancel();
        }
        if (target !== null) stats.lagMaxMs = Math.max(stats.lagMaxMs, time.nowMs() - target);
      }
      for (;;) {
        kick.clear();
        if (failure !== null) rethrow(failure);
        if (inflight.size === 0) break;
        const kicked = kick.wait();
        try {
          // oxlint-disable-next-line no-await-in-loop -- in-flight turns finish after the end, each settling with a kick
          await kicked.done;
        } finally {
          kicked.cancel();
        }
      }
      return host.finish();
    } catch (e) {
      failure ??= { error: e };
      for (const sleep of timers) sleep.cancel();
      timers.clear();
      throw e;
    }
  }

  return {
    stats: (): RealtimeStats => ({ ...stats }),
    async run(host: ClockHost, agents: ReadonlyMap<PlayerId, SeatAgent>): Promise<MatchResult> {
      if (running) throw new ClockError("this real-time driver is already running a match");
      running = true;
      stats = { iterations: 0, turns: 0, lagMaxMs: 0 };
      try {
        return await playMatch(host, agents);
      } finally {
        running = false;
      }
    },
  };
}
