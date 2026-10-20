import type { MatchStats } from "@perfidia/protocol/spectator";
import { useEffect, useState } from "react";
import { api, ApiFailure } from "../api/client.ts";

// A match's statistics (`GET /api/matches/:id/stats`, phase 4 Pass 3) for the dossier's model
// block: fetched once per match and shared by every seat's dossier; a running match's are fetched
// again when a dossier opens more than `FRESH_MS` after the last fetch (the route's own `max-age`
// is 10 s). A failure is kept as a short message: the block then shows what the seat list says.

const FRESH_MS = 10_000;
/** How many matches' statistics are kept. */
const KEPT = 8;

export type StatsState =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly value: MatchStats }
  | { readonly status: "error"; readonly code: string; readonly message: string };

interface Entry {
  readonly at: number;
  readonly promise: Promise<StatsState>;
  state: StatsState;
  /** The statistics held before this fetch (shown until it answers). */
  readonly before: StatsState | null;
}

const cache = new Map<string, Entry>();

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
          ? { status: "error", code: e.code, message: e.message }
          : { status: "error", code: "NETWORK", message: "the statistics could not be loaded" },
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

/** The statistics of match `id` (null: no match, or not asked yet); `running`: fetched again when stale. */
export function useMatchStats(id: string | null, running: boolean): StatsState | null {
  const [, setAnswers] = useState(0);
  useEffect(() => {
    if (id === null) return undefined;
    let held = cache.get(id);
    const stale =
      held === undefined ||
      held.state.status === "error" ||
      (running && performance.now() - held.at > FRESH_MS);
    if (held === undefined || stale) held = load(id);
    let alive = true;
    void held.promise.then(() => {
      if (alive) setAnswers((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [id, running]);
  return id === null ? null : shown(cache.get(id));
}
