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

/** What `describeError` answers for a value it cannot turn into a string. */
export const UNPRINTABLE_ERROR = "unprintable error";

/**
 * A thrown value as one deterministic line for the `turn` line's `error` (no stack, no address).
 * Total: an agent controls what it throws, so a value that cannot be printed (a throwing `message`
 * getter, a Symbol `name`, a revoked Proxy) gives `UNPRINTABLE_ERROR` instead of a second throw.
 */
export function describeError(e: unknown): string {
  try {
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    if (typeof e === "string") return e;
    return `non-Error thrown: ${String(e)}`;
  } catch {
    return UNPRINTABLE_ERROR;
  }
}
