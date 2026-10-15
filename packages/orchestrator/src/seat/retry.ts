import type { HarnessClock } from "../model/clock.ts";
import type { PauseGate } from "./pause.ts";

// The retry policy (phase-2 design §2.6): the only retry layer (the SDK runs with `maxRetries: 0`).
// Full-jitter exponential backoff, `sleep = random(0, min(cap, base × 2^k))`; a `retry-after`
// takes precedence, plus 0–2 s of jitter. The jitter matters because lockstep sends the woken seats'
// rounds together: a 429 hits them together, and identical backoffs would collide again. The
// budget (60 min in lockstep, the round deadline in real time) excludes time behind a closed gate.

export interface BackoffPolicy {
  readonly baseMs: number;
  readonly capMs: number;
  readonly retryAfterJitterMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = Object.freeze({
  baseMs: 5_000,
  capMs: 120_000,
  retryAfterJitterMs: 2_000,
});

/** The wait before retry number `k` (from 0). */
export function backoffMs(
  k: number,
  retryAfterMs: number | null,
  random: () => number,
  p: BackoffPolicy = DEFAULT_BACKOFF,
): number {
  if (retryAfterMs !== null) return retryAfterMs + Math.floor(random() * p.retryAfterJitterMs);
  let ceiling = p.baseMs;
  for (let i = 0; i < k && ceiling < p.capMs; i += 1) ceiling *= 2;
  return Math.floor(random() * Math.min(ceiling, p.capMs));
}

/** A retry budget whose clock stops while the pause gate is closed. */
export class RetryBudget {
  readonly budgetMs: number;
  private readonly clock: HarnessClock;
  private readonly gate: PauseGate;
  private readonly start: number;
  private readonly pausedAtStart: number;

  constructor(clock: HarnessClock, gate: PauseGate, budgetMs: number) {
    this.clock = clock;
    this.gate = gate;
    this.budgetMs = budgetMs;
    this.start = clock.time.nowMs();
    this.pausedAtStart = gate.pausedMs();
  }

  /** Wall ms used so far, paused time excluded. */
  elapsed(): number {
    const paused = this.gate.pausedMs() - this.pausedAtStart;
    return Math.max(0, this.clock.time.nowMs() - this.start - paused);
  }

  /** Whether a wait of `ms` still fits. */
  allows(ms: number): boolean {
    return this.elapsed() + ms <= this.budgetMs;
  }
}
