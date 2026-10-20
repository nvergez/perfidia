import type { PlayerId } from "@perfidia/protocol";
import { DEFAULT_MAX_OUTPUT_TOKENS, type CacheTtl, type Effort } from "./model/adapter.ts";

// The defaults of the first matches (phase-2 design §0, §4.4, §5.3, §10.2): the owner-pending
// choices, each overridable by an `arena run` flag. Agents are never told which seats are bots, nor
// which model plays which seat: nothing here reaches a prompt.

export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_EFFORT: Effort = "medium";
export const DEFAULT_MAX_TOKENS = DEFAULT_MAX_OUTPUT_TOKENS;

/** The safety cap of each LLM seat: $100, above the plan's high scenario ($77 per Opus seat). */
export const DEFAULT_CAP_NANO_USD = 100_000_000_000;
/** The per-wake soft cap: $2, about 10× a typical Opus wake. */
export const DEFAULT_WAKE_CAP_NANO_USD = 2_000_000_000;
/** Concurrent requests per model. */
export const DEFAULT_MAX_INFLIGHT = 4;

/** The first matches run in lockstep; real time waits for resume (§9.3). */
export const DEFAULT_CLOCK = "lockstep";
/** Lockstep: wake gaps are short, so the 5-minute TTL stays warm; real time uses 1 h. */
export const cacheTtlFor = (clock: "lockstep" | "realtime"): CacheTtl =>
  clock === "lockstep" ? "5m" : "1h";

/** Retry waits per round in lockstep (game time stands still while a seat waits). */
export const DEFAULT_RETRY_BUDGET_MS = 60 * 60_000;
/** Total pause before the arena aborts (lockstep). */
export const DEFAULT_PAUSE_MAX_MS = 2 * 60 * 60_000;
/** Backstop of one HTTP attempt. */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 10 * 60_000;

/** The lockstep driver's round timeout: never shorter than a full retry budget plus a full pause. */
export function lockstepRoundTimeoutMs(
  retryBudgetMs = DEFAULT_RETRY_BUDGET_MS,
  pauseMaxMs = DEFAULT_PAUSE_MAX_MS,
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
): number {
  return retryBudgetMs + pauseMaxMs + 2 * attemptTimeoutMs;
}

export type SeatSpec =
  | {
      readonly seat: PlayerId;
      readonly kind: "llm";
      readonly provider: string;
      readonly model: string;
      readonly effort: Effort;
      /** A profile `id@n` (seat/personalities.ts). */
      readonly profile: string;
      /** OpenRouter: the pinned endpoint's full slug (phase 4). */
      readonly endpoint?: string;
    }
  | { readonly seat: PlayerId; readonly kind: "bot"; readonly label: string };

const llm = (seat: PlayerId, profile: string): SeatSpec => ({
  seat,
  kind: "llm",
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  profile,
});

/** p1–p4: Claude Opus 5.5 at `medium` with the four profiles; p5, p6: the war-call bots. */
export const DEFAULT_LINEUP: readonly SeatSpec[] = Object.freeze([
  llm("p1", "odysseus@1"),
  llm("p2", "achilles@1"),
  llm("p3", "penelope@1"),
  llm("p4", "agamemnon@1"),
  { seat: "p5", kind: "bot", label: "bot:opportunist@3" },
  { seat: "p6", kind: "bot", label: "bot:conqueror@3" },
]);
