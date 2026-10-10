import type { JsonObject } from "@perfidia/protocol";

// Thrown engine errors (docs/architecture.md §5.3). Player errors are `Violation` data, never
// exceptions; `MatchConfigError` (in `checks.ts`) and `SnapshotMismatch` reject a setup or a snapshot
// before anything runs; `EngineMisuse` and `EngineBug` abort the match.

/** What went wrong inside the engine, as the `fatal` log line names it (§10.2). */
export type EngineBugKind = "invariant" | "engine";

/**
 * An invariant failure, or a handler or hook that threw. The match is aborted: every later call on
 * it throws `EngineMisuse`. `kind` maps onto the `fatal` line's error kind.
 */
export class EngineBug extends Error {
  readonly kind: EngineBugKind;
  readonly details: JsonObject;

  constructor(kind: EngineBugKind, message: string, details: JsonObject = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EngineBug";
    this.kind = kind;
    this.details = details;
  }
}

/** A driver bug: time going backwards, an unknown seat, a malformed action, a call after an abort. */
export class EngineMisuse extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineMisuse";
  }
}

/** A snapshot that does not match the ruleset, the config or its own hash (§5.3 "Loading"). */
export class SnapshotMismatch extends Error {
  /** The mismatching field: `format`, `ruleset`, `config`, `configHash`, `rulesHash`, `state`, `ext`, `hash`, … */
  readonly field: string;

  constructor(field: string, message: string) {
    super(`snapshot ${field}: ${message}`);
    this.name = "SnapshotMismatch";
    this.field = field;
  }
}

/** The message of any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Runs `fn`, turning anything it throws into an `EngineBug` of kind `engine` that names `what`.
 * `EngineBug` and `EngineMisuse` pass through unchanged.
 */
export function asEngineBug<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof EngineBug || error instanceof EngineMisuse) throw error;
    throw new EngineBug("engine", `${what} threw ${errorMessage(error)}`, {}, error);
  }
}
