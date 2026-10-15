import type { TimeSource } from "@perfidia/protocol";

// The wall clock of the harness (phase-2 design §1.4, §2.6): one `TimeSource` for the match clock,
// the bots' think time and the retries, plus the randomness of the retry jitter. Tests inject
// `VirtualTime` and a seeded `random`, so retries and pauses are deterministic and instant.

export interface HarnessClock {
  readonly time: TimeSource;
  /** Uniform in [0, 1): the retry and rate-gate jitter. */
  random(): number;
  /** The wall date as ISO 8601 for the informational `wall*` fields; absent in tests. */
  iso?(): string;
}

/** Thrown into a sleep or a wait when its signal aborts: the signal's reason, or this. */
export class AbortedError extends Error {
  override readonly name = "AbortedError";
}

/** Why `signal` aborted, as an `Error`. */
export function abortReason(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error ? r : new AbortedError("aborted");
}

/**
 * Resolves after `ms` (rounded down, at least 0) of `time`; rejects with the signal's reason when
 * the signal aborts first, cancelling the timer so virtual time never jumps to it.
 */
export function sleepMs(time: TimeSource, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortReason(signal));
  const sleep = time.sleepUntil(time.nowMs() + Math.max(0, Math.floor(ms)));
  if (signal === undefined) return sleep.done;
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      sleep.cancel();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    sleep.done.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** An `AbortSignal` that aborts after `ms` of `time`, with `cancel()` to drop the timer. */
export function timeoutSignal(
  time: TimeSource,
  ms: number,
  reason: string,
): { readonly signal: AbortSignal; cancel(): void } {
  const ctl = new AbortController();
  const sleep = time.sleepUntil(time.nowMs() + Math.max(0, Math.floor(ms)));
  void sleep.done.then(() => ctl.abort(new AbortedError(reason)));
  return { signal: ctl.signal, cancel: () => sleep.cancel() };
}

/** mulberry32 as a [0, 1) source: the seeded jitter of tests and `--fake` runs. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
