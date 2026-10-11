import { assertSafeInt, insertSorted, removeWhere } from "@perfidia/engine/core";
import type { Sleep, TimeSource } from "@perfidia/protocol";

// Virtual wall time (docs/architecture.md §9.4): a deterministic `TimeSource` that runs real-time
// matches as fast as the CPU allows. Pure: it never reads a clock and never schedules a host timer;
// the macrotask yield it needs is injected (the sim harness passes `setImmediate`).

/** The task `VirtualTime.run` drives is pending and no timer is left to fire. */
export class VirtualTimeDeadlock extends Error {
  override readonly name = "VirtualTimeDeadlock";
  /** Virtual time at the deadlock, in ms. */
  readonly atMs: number;

  constructor(atMs: number) {
    super(
      `virtual time deadlock at ${atMs} ms: the task is still pending and no timer is left. ` +
        "Something awaited work that virtual time does not drive (real I/O, a host timer, a promise nobody settles).",
    );
    this.atMs = atMs;
  }
}

export interface VirtualTimeOptions {
  /**
   * Resolves after one macrotask, e.g. `() => new Promise((r) => setImmediate(r))`. One macrotask
   * yield drains every pending microtask chain, so in-process agents interleave deterministically.
   */
  readonly yieldMacrotask: () => Promise<void>;
  /** Initial `nowMs()`, default 0. */
  readonly startMs?: number;
}

interface Timer {
  readonly ms: number;
  readonly seq: number;
  readonly resolve: () => void;
}

const byDeadline = (a: Timer, b: Timer): number => a.ms - b.ms || a.seq - b.seq;

export class VirtualTime implements TimeSource {
  readonly #yield: () => Promise<void>;
  #now: number;
  #seq = 0;
  /** Live timers, sorted by `(ms, seq)`. */
  readonly #timers: Timer[] = [];
  #running = false;

  constructor(options: VirtualTimeOptions) {
    this.#yield = options.yieldMacrotask;
    this.#now = assertSafeInt(options.startMs ?? 0, "VirtualTime startMs");
  }

  nowMs(): number {
    return this.#now;
  }

  /**
   * A timer at `ms` (a deadline in the past fires at the current time, after the timers already
   * due). Timers fire one at a time in `(ms, creation order)`; `cancel()` removes the timer, so
   * virtual time never jumps to a deadline nobody waits for any more.
   */
  sleepUntil(ms: number): Sleep {
    assertSafeInt(ms, "sleepUntil deadline");
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer: Timer = { ms: Math.max(ms, this.#now), seq: this.#seq, resolve };
    this.#seq += 1;
    insertSorted(this.#timers, timer, byDeadline);
    return {
      done: promise,
      cancel: () => void removeWhere(this.#timers, (t) => t === timer),
    };
  }

  /** Timers neither fired nor cancelled. */
  get pending(): number {
    return this.#timers.length;
  }

  /**
   * Drives `main` to completion: yields one macrotask, returns (or throws) once `main` has settled,
   * otherwise jumps to the earliest timer and fires it, and repeats. Throws `VirtualTimeDeadlock`
   * when `main` is pending and no timer is left. One `run` at a time per instance; separate
   * instances may run concurrently in one process (§13.4).
   */
  async run<T>(main: Promise<T> | (() => Promise<T>)): Promise<T> {
    if (this.#running) throw new Error("VirtualTime.run is already running on this instance");
    this.#running = true;
    try {
      const task = typeof main === "function" ? main() : main;
      let settled = false;
      const mark = (): void => {
        settled = true;
      };
      task.then(mark, mark);
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- each timer fires only after the microtasks of the previous one have drained
        await this.#yield();
        if (settled) return task;
        const timer = this.#timers.shift();
        if (timer === undefined) throw new VirtualTimeDeadlock(this.#now);
        this.#now = timer.ms;
        timer.resolve();
      }
    } finally {
      this.#running = false;
    }
  }
}
