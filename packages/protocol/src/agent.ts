import type { Briefing } from "./briefing.ts";
import type { PlayerId } from "./ids.ts";
import type { ToolCall, ToolResult } from "./tools.ts";

// The agent contract (§9.1), type-only. The host drives the turn loop round by round; every input
// an agent receives is a canonical copy (§6.6).

export interface RoundInput {
  readonly seat: PlayerId;
  /** The seat's turn number, from 1. */
  readonly turn: number;
  /** 0-based. */
  readonly round: number;
  readonly maxRounds: number;
  /** This round's call cap. */
  readonly maxCalls: number;
  /** The same briefing every round of the turn. */
  readonly briefing: Briefing;
  /** Results of the previous round's calls (`[]` in round 0), in call order. */
  readonly results: readonly ToolResult[];
}

export interface RoundOutput {
  /** `[]` ends the turn. */
  readonly calls: readonly ToolCall[];
  /** The last one becomes the turn's public thought. */
  readonly thought?: string;
}

export interface SeatAgent {
  /** A versioned controller label, e.g. `bot:expander@1`. */
  readonly label: string;
  round(input: RoundInput): Promise<RoundOutput>;
}

export interface Sleep {
  readonly done: Promise<void>;
  /** Removes the timer; `done` then never settles. */
  cancel(): void;
}

/** Wall time, injected: pure code never reads a clock (§9.4). */
export interface TimeSource {
  /** Integer milliseconds, monotonic. */
  nowMs(): number;
  sleepUntil(ms: number): Sleep;
}
