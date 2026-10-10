import type { PlayerId } from "@perfidia/protocol";
import type { TurnFailure } from "./types.ts";

/** A driver misconfigured, or a host that broke the `ClockHost` contract (§9.1). Always fatal. */
export class ClockError extends Error {
  override readonly name = "ClockError";
}

/**
 * An agent's round failed while the driver runs in strict mode, where agent errors are fatal
 * (tests, §8.7). The turn is closed with the error before this is thrown.
 */
export class AgentRoundError extends Error {
  override readonly name = "AgentRoundError";
  readonly seat: PlayerId;
  readonly failure: TurnFailure;

  constructor(seat: PlayerId, failure: TurnFailure, message: string) {
    super(`${seat}: round ${failure === "timeout" ? "timed out" : "failed"}: ${message}`);
    this.seat = seat;
    this.failure = failure;
  }
}

/** A thrown value as one deterministic line for the `turn` line's `error` (no stack, no address). */
export function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "string") return e;
  try {
    return `non-Error thrown: ${String(e)}`;
  } catch {
    return "non-Error thrown";
  }
}
