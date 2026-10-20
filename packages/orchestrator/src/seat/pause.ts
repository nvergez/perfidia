import { abortReason, sleepMs, type HarnessClock } from "../model/clock.ts";
import { isBreakerKind, type ModelErrorKind } from "../model/adapter.ts";
import type { PlayerId } from "@perfidia/protocol";

// The arena pause gate and circuit breaker (phase-2 design §2.6). Every model attempt first awaits
// the gate. An operator-recoverable failure (key, credit, model access) or a tripped breaker closes
// it:
// - lockstep (`mode: "wait"`): the next LLM round waits at the gate (game time stands still once
//   one waits; the bots play until then), a probe (the preflight) runs every `probeEveryMs` and
//   reopens the gate when it passes; after `pauseMaxMs` of pause in total, the arena aborts. A
//   passing probe cannot prove a breaker's cause gone (the preflight is not the failing request),
//   so a breaker that trips again before any LLM turn closed cleanly since its last resume aborts
//   the arena: the cause persists, and a match whose LLM seats all fail is not left to "end";
// - real time (`mode: "abort"`): game time cannot stop, so an operator-recoverable failure aborts
//   at once, and a tripped breaker is an alert (`onAlert`): aborting would end a multi-day match
//   with no resume, while LLM turns that fail only close themselves. As in lockstep, a breaker that
//   trips again before any LLM turn closed cleanly since that alert aborts the arena.
// Time behind a closed gate never counts against a retry budget (`pausedMs`). The arena (file
// writing, `arena.json`, exit codes) hooks in through `onPause`, `onResume`, `onAbort`, `onAlert`.

/** Why the gate closed, or why the arena aborted (`budget`, `operator`: phase 4). */
export interface PauseReason {
  readonly kind: ModelErrorKind | "breaker" | "budget" | "operator";
  readonly message: string;
  readonly seat: PlayerId | null;
  readonly model: string | null;
}

/** What the breaker counts. */
export type GateEvent =
  | { readonly k: "attempt_ok"; readonly model: string }
  | {
      readonly k: "attempt_failed";
      readonly model: string;
      readonly seat: PlayerId;
      readonly kind: ModelErrorKind;
    }
  | { readonly k: "turn_ok"; readonly seat: PlayerId }
  | {
      readonly k: "turn_error";
      readonly seat: PlayerId;
      readonly error: string;
      /** Not a refusal, a truncation or a deadline abort (`AgentError.systemic`). */
      readonly systemic: boolean;
    };

export interface PauseGate {
  /** Resolves while the gate is open; waits while it is closed; rejects with `ArenaAborted` once aborted. */
  open(signal?: AbortSignal): Promise<void>;
  /** Closes the gate (operator-recoverable failure). Idempotent while closed. */
  close(reason: PauseReason): void;
  /** Breaker input. */
  record(event: GateEvent): void;
  /** Wall ms spent closed so far, the current pause included. */
  pausedMs(): number;
}

/** The arena gave up: a pause longer than `pauseMaxMs`, or any pause in real time. */
export class ArenaAborted extends Error {
  override readonly name = "ArenaAborted";
  readonly reason: PauseReason;

  constructor(reason: PauseReason, why: string) {
    super(`arena aborted (${why}): ${reason.kind}: ${reason.message}`);
    this.reason = reason;
  }
}

/**
 * The circuit breaker: trips on 3 consecutive non-retryable failures (`bad_request`, `too_large`,
 * `unknown`) of one model with no success in between, or on 3 consecutive LLM turns, any seats,
 * closed by a systemic error. A refused, truncated or deadline-aborted turn neither counts nor
 * resets: it is about one request (refusals are watched by the arena's refusal alert, §3.8).
 */
export class Breaker {
  readonly threshold: number;
  private readonly failures = new Map<string, number>();
  private turnErrors = 0;

  constructor(threshold = 3) {
    this.threshold = threshold;
  }

  /** The reason to close the gate when this event trips the breaker; `null` otherwise. */
  record(e: GateEvent): PauseReason | null {
    if (e.k === "attempt_ok") {
      this.failures.set(e.model, 0);
      return null;
    }
    if (e.k === "attempt_failed") {
      if (!isBreakerKind(e.kind)) return null;
      const n = (this.failures.get(e.model) ?? 0) + 1;
      this.failures.set(e.model, n);
      if (n < this.threshold) return null;
      this.failures.set(e.model, 0);
      return {
        kind: "breaker",
        message: `${n} consecutive ${e.kind} failures on ${e.model}`,
        seat: e.seat,
        model: e.model,
      };
    }
    if (e.k === "turn_ok") {
      this.turnErrors = 0;
      return null;
    }
    if (!e.systemic) return null;
    this.turnErrors += 1;
    if (this.turnErrors < this.threshold) return null;
    const n = this.turnErrors;
    this.turnErrors = 0;
    return {
      kind: "breaker",
      message: `${n} consecutive LLM turns closed by an error (last: ${e.seat}: ${e.error})`,
      seat: e.seat,
      model: null,
    };
  }
}

export interface GateOptions {
  readonly clock: HarnessClock;
  /** `wait`: lockstep; `abort`: real time. */
  readonly mode: "wait" | "abort";
  /** Re-checks the API (the preflight); `true` reopens the gate. */
  readonly probe: () => Promise<boolean>;
  /** Default 2 minutes. */
  readonly probeEveryMs?: number;
  /** Total pause before the arena aborts; default 2 hours. */
  readonly pauseMaxMs?: number;
  readonly breaker?: Breaker;
  readonly onPause?: (reason: PauseReason) => void;
  readonly onResume?: (reason: PauseReason, pausedMs: number) => void;
  readonly onAbort?: (error: ArenaAborted) => void;
  /** Real time: a tripped breaker (no pause, no abort). */
  readonly onAlert?: (reason: PauseReason) => void;
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (e: Error) => void;
}

const PERSISTS = "the breaker tripped again before any LLM turn closed cleanly";

/** The gate of a whole arena: one per process, shared by every LLM seat. */
export class ArenaPauseGate implements PauseGate {
  private readonly o: GateOptions;
  private readonly breaker: Breaker;
  private closedBy: PauseReason | null = null;
  private closedAt = 0;
  private pausedTotal = 0;
  private aborted: ArenaAborted | null = null;
  /** A breaker pause was resumed (real time: alerted) and no LLM turn has closed cleanly since. */
  private breakerOnProbation = false;
  private readonly waiters: Waiter[] = [];

  constructor(o: GateOptions) {
    this.o = o;
    this.breaker = o.breaker ?? new Breaker();
  }

  get isClosed(): boolean {
    return this.closedBy !== null;
  }

  get abortError(): ArenaAborted | null {
    return this.aborted;
  }

  pausedMs(): number {
    const now = this.o.clock.time.nowMs();
    return this.pausedTotal + (this.closedBy === null ? 0 : now - this.closedAt);
  }

  open(signal?: AbortSignal): Promise<void> {
    if (this.aborted !== null) return Promise.reject(this.aborted);
    if (this.closedBy === null) return Promise.resolve();
    if (signal?.aborted === true) return Promise.reject(abortReason(signal));
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        if (signal !== undefined) reject(abortReason(signal));
      };
      const waiter: Waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  record(event: GateEvent): void {
    if (event.k === "turn_ok") this.breakerOnProbation = false;
    const trip = this.breaker.record(event);
    if (trip === null) return;
    if (this.o.mode === "abort") {
      if (this.aborted !== null) return;
      if (this.breakerOnProbation) {
        this.abort(trip, `${PERSISTS} since its last alert: the cause persists`);
        return;
      }
      this.breakerOnProbation = true;
      this.o.onAlert?.(trip);
      return;
    }
    this.close(trip);
  }

  close(reason: PauseReason): void {
    if (this.aborted !== null || this.closedBy !== null) return;
    if (this.o.mode === "abort") {
      this.abort(reason, "real time cannot pause");
      return;
    }
    if (reason.kind === "breaker" && this.breakerOnProbation) {
      this.abort(reason, `${PERSISTS} since its last resume: the cause persists`);
      return;
    }
    this.closedBy = reason;
    this.closedAt = this.o.clock.time.nowMs();
    this.o.onPause?.(reason);
    void this.probeLoop(reason);
  }

  private async probeLoop(reason: PauseReason): Promise<void> {
    const every = this.o.probeEveryMs ?? 120_000;
    const max = this.o.pauseMaxMs ?? 7_200_000;
    for (;;) {
      const left = max - this.pausedMs();
      if (left <= 0) {
        this.abort(reason, `paused for more than ${max} ms`);
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- one probe at a time, every `every` ms
      await sleepMs(this.o.clock.time, Math.min(every, left));
      if (this.pausedMs() >= max) continue;
      let ok = false;
      try {
        // oxlint-disable-next-line no-await-in-loop -- the probe decides the next step
        ok = await this.o.probe();
      } catch {
        ok = false;
      }
      if (ok) {
        this.reopen(reason);
        return;
      }
    }
  }

  private reopen(reason: PauseReason): void {
    const paused = this.o.clock.time.nowMs() - this.closedAt;
    this.pausedTotal += paused;
    this.closedBy = null;
    if (reason.kind === "breaker") this.breakerOnProbation = true;
    this.o.onResume?.(reason, paused);
    for (const w of this.waiters.splice(0)) w.resolve();
  }

  /**
   * Aborts the arena now, through the same path as a pause past its maximum: every waiter and every
   * later `open` rejects with `ArenaAborted` (phase 4: `--on-budget abort`, a second operator
   * signal). Idempotent.
   */
  abort(reason: PauseReason, why: string): void {
    if (this.aborted !== null) return;
    if (this.closedBy !== null) {
      this.pausedTotal += this.o.clock.time.nowMs() - this.closedAt;
      this.closedBy = null;
    }
    const error = new ArenaAborted(reason, why);
    this.aborted = error;
    this.o.onAbort?.(error);
    for (const w of this.waiters.splice(0)) w.reject(error);
  }
}

/** A gate that never closes: tests and runs without an operator (`close` aborts every later wait). */
export class NoPauseGate implements PauseGate {
  private aborted: ArenaAborted | null = null;
  readonly events: GateEvent[] = [];

  open(): Promise<void> {
    return this.aborted === null ? Promise.resolve() : Promise.reject(this.aborted);
  }

  close(reason: PauseReason): void {
    this.aborted ??= new ArenaAborted(reason, "no pause gate");
  }

  record(event: GateEvent): void {
    this.events.push(event);
  }

  pausedMs(): number {
    return 0;
  }
}
