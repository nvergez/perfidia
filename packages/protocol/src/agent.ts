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

/**
 * How the gateway presents a seat's briefings and read results (§8.2). `1`, the default, is phase
 * 1's compact presentation: what bots read and goldens record. `2` is the LLM seats' (prompt version
 * 3 on): a larger briefing whose cuts keep the events the wake names, building levels per city, the
 * island of a found movement, exact `more` calls, and `read_notes` search and open results without
 * the notebook. Game state and the log's lines are the same under both, `obs` sizes aside.
 */
export type Presentation = 1 | 2;

export interface SeatAgent {
  /** A versioned controller label, e.g. `bot:expander@1`. */
  readonly label: string;
  /** How the gateway presents this agent's briefings and read results; `1` when absent. */
  readonly presentation?: Presentation;
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
