import { abortReason, sleepMs, type HarnessClock } from "./clock.ts";

// The rate gate of one (provider, model) (phase-2 design §2.6): at most `maxInflight` requests at
// once, and a shared "not before" time that a 429 or 529 sets, so one seat's rate limit holds every
// seat on that model instead of each discovering it. Lockstep wakes seats together, so a release
// after a hold is jittered per waiter: the seats do not hit the API again in the same millisecond.

export interface RateGateOptions {
  readonly clock: HarnessClock;
  /** Concurrent requests on the model; default 4. */
  readonly maxInflight?: number;
  /** Each waiter adds `random() × releaseJitterMs` after a hold; default 2000. */
  readonly releaseJitterMs?: number;
}

interface Waiter {
  readonly resolve: () => void;
}

export class RateGate {
  readonly maxInflight: number;
  private readonly clock: HarnessClock;
  private readonly jitterMs: number;
  private inflightCount = 0;
  private notBeforeMs = 0;
  private readonly queue: Waiter[] = [];

  constructor(o: RateGateOptions) {
    this.clock = o.clock;
    this.maxInflight = o.maxInflight ?? 4;
    this.jitterMs = o.releaseJitterMs ?? 2_000;
    if (!Number.isSafeInteger(this.maxInflight) || this.maxInflight < 1) {
      throw new Error(`maxInflight must be an integer ≥ 1, got ${this.maxInflight}`);
    }
  }

  get inflight(): number {
    return this.inflightCount;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** The wall time (ms of the clock) before which no request starts. */
  get notBefore(): number {
    return this.notBeforeMs;
  }

  /** A 429 or 529: no request on this model starts before `ms` from now. */
  holdFor(ms: number): void {
    const until = this.clock.time.nowMs() + Math.max(0, Math.floor(ms));
    if (until > this.notBeforeMs) this.notBeforeMs = until;
  }

  /**
   * Waits for any hold to pass (plus jitter) and for a free slot; resolves with the slot's release
   * function, which must be called exactly once. Rejects when `signal` aborts while waiting.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    for (;;) {
      const now = this.clock.time.nowMs();
      if (now < this.notBeforeMs) {
        const wait = this.notBeforeMs - now + Math.floor(this.clock.random() * this.jitterMs);
        // oxlint-disable-next-line no-await-in-loop -- a hold set while sleeping is honoured too
        await sleepMs(this.clock.time, wait, signal);
        continue;
      }
      if (this.inflightCount < this.maxInflight) {
        this.inflightCount += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.inflightCount -= 1;
          this.queue.shift()?.resolve();
        };
      }
      // oxlint-disable-next-line no-await-in-loop -- woken by a release, then re-checks the hold
      await this.waitForSlot(signal);
    }
  }

  private waitForSlot(signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(abortReason(signal));
        return;
      }
      const waiter: Waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = (): void => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        if (signal !== undefined) reject(abortReason(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }
}

/** One `RateGate` per (provider, model), created on first use. */
export class RateGates {
  private readonly gates = new Map<string, RateGate>();
  private readonly options: RateGateOptions;

  constructor(options: RateGateOptions) {
    this.options = options;
  }

  gate(provider: string, model: string): RateGate {
    const key = `${provider}/${model}`;
    let g = this.gates.get(key);
    if (g === undefined) {
      g = new RateGate(this.options);
      this.gates.set(key, g);
    }
    return g;
  }
}
