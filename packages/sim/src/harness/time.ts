import { VirtualTime, type WallSource } from "@perfidia/gateway";
import type { Sleep, TimeSource } from "@perfidia/protocol";

// Time sources for the sim harness (docs/architecture.md §9.4, §12.1): `SystemTime` and the system
// wall clock for real runs, and `VirtualTime` wired to `setImmediate` so real-time matches run fast
// and reproducibly in one process.

/** Wall time from `performance.now()` (integer ms, monotonic) and cancellable `setTimeout`s. */
export class SystemTime implements TimeSource {
  nowMs(): number {
    return Math.floor(performance.now());
  }

  sleepUntil(ms: number): Sleep {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, Math.max(0, ms - this.nowMs()));
    return { done: promise, cancel: () => clearTimeout(timer) };
  }
}

/** The wall source of a system-clock run: `wall*` keys of the log (informational only). */
export const systemWall: WallSource = Object.freeze({
  nowMs: (): number => Math.floor(performance.now()),
  iso: (): string => new Date().toISOString(),
});

/** One macrotask: drains every pending microtask chain (§9.4). */
export function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A fresh `VirtualTime` driven by `setImmediate`; each match gets its own (§13.4). */
export function createVirtualTime(startMs = 0): VirtualTime {
  return new VirtualTime({ yieldMacrotask, startMs });
}
