import type {
  GameTime,
  MatchResult,
  PlayerId,
  RoundInput,
  RoundOutput,
  SeatAgent,
} from "@perfidia/protocol";

// The contract between a clock driver and the match host (docs/architecture.md §9.1). The host
// (`MatchHost`, §8.7) owns the engine, the gateway state and the log; a driver only decides when
// game time moves and when seats play. Every host method is synchronous, so a round's calls are a
// critical section with respect to the event loop and the log order is the application order.

/**
 * Why a driver closed a turn with an error: the agent's round threw, rejected or answered
 * something that is not a `RoundOutput` (`"error"`), or it did not answer within the round timeout
 * (`"timeout"`). The host records it as the `turn` line's `why`.
 */
export type TurnFailure = "error" | "timeout";

export interface ClockHost {
  /** The match seed (uint32): lockstep batch orders are drawn from its `lockstep:<t>:<b>` streams. */
  readonly seed: number;
  /** The game second at which the match ends (`match_end`). */
  readonly endsAt: GameTime;
  now(): GameTime;
  ended(): boolean;
  /** Header line, then `advanceTo(0)`. */
  start(): void;
  /** Engine step, event delivery, `ev`/`ckpt` lines, snapshots. `t` ≥ `now()`; `t = now()` is a no-op. */
  advanceTo(t: GameTime): void;
  /** `min(next engine event, next idle seat's wake)`; `null` once the match has ended. */
  nextTime(): GameTime | null;
  /** Idle, alive seats whose wake time is ≤ `t`, by player number. Seats in a turn are never due. */
  dueSeats(t: GameTime): PlayerId[];
  /** `wake` line and briefing at `now()`; the seat is in a turn until its handle is closed. */
  openTurn(seat: PlayerId): TurnHandle;
  /** `batch` line: the seeded order of lockstep batch `b` at second `t`. */
  logBatch(t: GameTime, b: number, order: readonly PlayerId[]): void;
  /** `defer` line: the seat's wake moves to `to` (lockstep per-second turn cap). */
  defer(seat: PlayerId, to: GameTime): void;
  /** `end` line. */
  finish(): MatchResult;
}

export interface TurnHandle {
  readonly seat: PlayerId;
  /** `end_turn`, an empty round, the round cap, the end of the match, or the seat eliminated. */
  readonly done: boolean;
  input(): RoundInput;
  /** Synchronous: applies the round's calls at `host.now()`, in order. */
  execute(out: RoundOutput): void;
  /**
   * `turn` line, then the scheduler's `end` (which clears `inTurn` synchronously). `error` is the
   * agent failure that closed the turn and `cause` its kind (default `"error"` when `error` is
   * given). `cause` extends §9.1, whose signature is `close(error?: string)`: a host written to
   * that signature still satisfies this interface.
   */
  close(error?: string, cause?: TurnFailure): void;
}

export interface ClockDriver {
  /** Plays the match from `host.start()` to `host.finish()` and returns its result. */
  run(host: ClockHost, agents: ReadonlyMap<PlayerId, SeatAgent>): Promise<MatchResult>;
}
