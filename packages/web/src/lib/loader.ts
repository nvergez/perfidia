// A part of the app loaded on demand (a dynamic `import()` chunk, docs/phase3.md §16): its state,
// one promise while it loads, and a retry after a failure. Pure (no DOM); `common/lazy.tsx` renders
// it, and its listeners are what `useSyncExternalStore` subscribes to.

export type LoadState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "failed"; readonly error: unknown };

export interface Loader<T> {
  /** The state now (the same object until it changes). */
  readonly state: () => LoadState<T>;
  /**
   * Starts loading: again after a failure, never twice at once (the same promise while it loads).
   * Never rejects: a failure is the `failed` state.
   */
  readonly load: () => Promise<LoadState<T>>;
  readonly subscribe: (listener: () => void) => () => void;
}

const IDLE = Object.freeze({ status: "idle" as const });
const LOADING = Object.freeze({ status: "loading" as const });

export function createLoader<T>(importer: () => Promise<T>): Loader<T> {
  let state: LoadState<T> = IDLE;
  let pending: Promise<LoadState<T>> | null = null;
  const listeners = new Set<() => void>();
  const setState = (next: LoadState<T>): LoadState<T> => {
    state = next;
    for (const l of listeners) l();
    return next;
  };
  return {
    state: () => state,
    load(): Promise<LoadState<T>> {
      if (state.status === "ready") return Promise.resolve(state);
      if (pending !== null) return pending;
      setState(LOADING);
      let started: Promise<T>;
      try {
        started = importer();
      } catch (error: unknown) {
        started = Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      // The callbacks run after this assignment (a promise settles asynchronously).
      pending = started.then(
        (value) => {
          pending = null;
          return setState({ status: "ready", value });
        },
        (error: unknown) => {
          pending = null;
          return setState({ status: "failed", error });
        },
      );
      return pending;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
