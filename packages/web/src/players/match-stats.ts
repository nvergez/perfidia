import type { MatchStats, MatchStatus } from "@perfidia/protocol/spectator";
import { useEffect, useState } from "react";
import { api, ApiFailure } from "../api/client.ts";
import { isRunningStatus } from "../store/session.ts";

// A match's statistics (`GET /api/matches/:id/stats`, phase 4 Pass 3) for the dossier's model
// block: fetched once per match and shared by every seat's dossier, and fetched again when they no
// longer describe the match: the match's status moved on from the one they were made at (a match
// that was loading, or running, has ended), or a running match's are older than `FRESH_MS` (the
// route's own `max-age` is 10 s). A `LOADING` answer (the server is still folding the match) is
// asked again after its `Retry-After`. A failure is kept as a short message: the block then shows
// what the seat list says.

const FRESH_MS = 10_000;
/** How many matches' statistics are kept. */
const KEPT = 8;
/** `LOADING` answers asked again, at most (each after the server's `Retry-After`, up to 10 s). */
const LOADING_RETRIES = 30;

export type StatsState =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly value: MatchStats }
  | {
      readonly status: "error";
      readonly code: string;
      readonly message: string;
      readonly retryAfter: number | null;
    };

interface Entry {
  readonly at: number;
  readonly promise: Promise<StatsState>;
  state: StatsState;
  /** The statistics held before this fetch (shown until it answers). */
  readonly before: StatsState | null;
}

const cache = new Map<string, Entry>();

/** What `statsStale` reads of a held entry. */
export interface HeldStats {
  readonly at: number;
  readonly state:
    | { readonly status: "loading" }
    | { readonly status: "error" }
    | { readonly status: "ok"; readonly value: { readonly status: MatchStatus } };
}

/**
 * Whether held statistics must be fetched again: none held, a failure, statistics of another
 * status than the match's now (it ended since), or a running match's older than `FRESH_MS`. A
 * fetch in flight is never stale.
 */
export function statsStale(
  held: HeldStats | undefined,
  status: MatchStatus | null,
  now: number,
): boolean {
  if (held === undefined) return true;
  const s = held.state;
  if (s.status === "loading") return false;
  if (s.status === "error") return true;
  if (status !== null && s.value.status !== status) return true;
  return isRunningStatus(status) && now - held.at > FRESH_MS;
}

function load(id: string): Entry {
  const held = cache.get(id)?.state ?? null;
  const entry: Entry = {
    at: performance.now(),
    state: { status: "loading" },
    before: held?.status === "ok" ? held : null,
    promise: api.matchStats(id).then(
      (value): StatsState => ({ status: "ok", value }),
      (e: unknown): StatsState =>
        e instanceof ApiFailure
          ? { status: "error", code: e.code, message: e.message, retryAfter: e.retryAfter }
          : {
              status: "error",
              code: "NETWORK",
              message: "the statistics could not be loaded",
              retryAfter: null,
            },
    ),
  };
  void entry.promise.then((s) => {
    entry.state = s;
  });
  cache.delete(id);
  cache.set(id, entry);
  while (cache.size > KEPT) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
  return entry;
}

/** What to show of an entry: its state, or while it loads the statistics held before. */
function shown(e: Entry | undefined): StatsState | null {
  if (e === undefined) return null;
  return e.state.status === "loading" && e.before !== null ? e.before : e.state;
}

/** The statistics of match `id` (null: no match, or not asked yet), kept current with `status`. */
export function useMatchStats(id: string | null, status: MatchStatus | null): StatsState | null {
  const [, setAnswers] = useState(0);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (id === null) return undefined;
    let held = cache.get(id);
    if (held === undefined || statsStale(held, status, performance.now())) held = load(id);
    let alive = true;
    let timer: number | null = null;
    void held.promise.then((s) => {
      if (!alive) return;
      setAnswers((n) => n + 1);
      if (s.status === "error" && s.code === "LOADING" && retry < LOADING_RETRIES) {
        const seconds = Math.min(10, Math.max(1, s.retryAfter ?? 2));
        timer = window.setTimeout(() => setRetry((n) => n + 1), seconds * 1000);
      }
    });
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [id, status, retry]);
  return id === null ? null : shown(cache.get(id));
}
