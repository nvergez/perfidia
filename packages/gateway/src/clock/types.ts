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

/** The agent failure that closes a turn: the host writes `error` and `cause` as the `turn` line's `error` and `why`. */
export interface AgentFailure {
  /** One deterministic line, no stack (`describeError`). */
  readonly error: string;
  readonly cause: TurnFailure;
}

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
  /**
   * Synchronous: applies the round's calls at `host.now()`, in order. `done` may have become true
   * while the agent was thinking, because the match ended or the seat was eliminated (in lockstep,
   * by a seat applied earlier in the same batch): a driver still executes that one answered round,
   * so it is logged, and the host must accept it and answer each call `MATCH_ENDED` or
   * `ELIMINATED`. A driver never executes a round after `end_turn`, an empty round or the round cap.
   */
  execute(out: RoundOutput): void;
  /**
   * `turn` line, then the scheduler's `end` (which clears `inTurn` synchronously). `failure` is the
   * agent failure that closed the turn; without it, the host derives `why` from the turn's state.
   * Deviation from §9.1, whose signature is `close(error?: string)`: the failure carries its cause,
   * so a timed-out round is logged as `why: "timeout"`. A host written to the §9.1 signature does
   * not compile against this one, on purpose: it would log every timeout as `why: "error"`.
   */
  close(failure?: AgentFailure): void;
}

export interface ClockDriver {
  /** Plays the match from `host.start()` to `host.finish()` and returns its result. */
  run(host: ClockHost, agents: ReadonlyMap<PlayerId, SeatAgent>): Promise<MatchResult>;
}
