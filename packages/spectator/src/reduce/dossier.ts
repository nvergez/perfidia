import type { FeedItem, NotebookHistory } from "@perfidia/protocol/spectator";

// What a dossier shows of a seat (phase-3 design §4.2 Pass C), for the web: its record over feed
// items (the store's feed holds every item up to the playhead, so these are counts at the
// playhead), and its notebook's versions as whole texts, rebuilt from the dossier's edits
// (`NotebookHistory`, written by the fold's `fold/series.ts`).

export interface SeatTally {
  /** Turns ended (a `turn` item each). */
  readonly turns: number;
  readonly messagesSent: number;
  /** Messages to the seat, or to everyone, from another seat. */
  readonly messagesReceived: number;
  /** Betrayals (the engine's `betrayal` event: an attack on an ally or pact partner landed). */
  readonly betrayalsCommitted: number;
  readonly betrayalsSuffered: number;
}

/** A seat's record over `items`. */
export function seatTally(items: Iterable<FeedItem>, seat: string): SeatTally {
  let turns = 0;
  let messagesSent = 0;
  let messagesReceived = 0;
  let betrayalsCommitted = 0;
  let betrayalsSuffered = 0;
  for (const it of items) {
    if (it.k === "turn") {
      if (it.seat === seat) turns += 1;
    } else if (it.k === "message") {
      if (it.from === seat) messagesSent += 1;
      else if (it.to === "all" || it.to.some((p) => p === seat)) messagesReceived += 1;
    } else if (it.k === "betrayal") {
      if (it.by === seat) betrayalsCommitted += 1;
      else if (it.against === seat) betrayalsSuffered += 1;
    }
  }
  return { turns, messagesSent, messagesReceived, betrayalsCommitted, betrayalsSuffered };
}

/**
 * The notebook's kept versions as whole texts, oldest first; null when an edit does not fit the
 * version before it (a history that was not written by the fold).
 */
export function notebookTexts(h: NotebookHistory): string[] | null {
  const out: string[] = [];
  let prev = "";
  for (const [i, v] of h.versions.entries()) {
    if (i === 0 ? v.head !== 0 || v.tail !== 0 : v.head + v.tail > prev.length) return null;
    prev = prev.slice(0, v.head) + v.text + prev.slice(prev.length - v.tail);
    out.push(prev);
  }
  return out;
}
