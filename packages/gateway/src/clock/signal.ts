import type { Sleep } from "@perfidia/protocol";

/**
 * A level-triggered wake-up flag (the real-time driver's `kick`, §9.3). `notify()` raises it and
 * wakes every waiter; it stays raised until the consumer calls `clear()`. A consumer that clears
 * the flag before it reads the state it waits on, and waits only afterwards, never loses a
 * notification: a `notify()` that lands in between leaves the flag raised, so the next `wait()`
 * settles at once.
 */
export class Signal {
  #raised = false;
  readonly #waiters = new Set<() => void>();

  get raised(): boolean {
    return this.#raised;
  }

  /** Raises the flag and wakes every pending waiter. */
  notify(): void {
    this.#raised = true;
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }

  /** Lowers the flag. */
  clear(): void {
    this.#raised = false;
  }

  /**
   * Settles `done` once the flag is raised (at once if it already is); `wait` does not lower it.
   * `cancel()` drops the waiter, so a wait that lost a race leaves nothing behind.
   */
  wait(): Sleep {
    if (this.#raised) return { done: Promise.resolve(), cancel: () => undefined };
    const { promise, resolve } = Promise.withResolvers<void>();
    const wake = (): void => resolve();
    this.#waiters.add(wake);
    return { done: promise, cancel: () => void this.#waiters.delete(wake) };
  }

  /** Waiters not yet woken or cancelled (for tests). */
  get waiting(): number {
    return this.#waiters.size;
  }
}
