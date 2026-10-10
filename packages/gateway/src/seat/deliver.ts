import type { DomainEvent, GatewayRules, Json } from "@perfidia/protocol";
import { dayOf, isSeat, seatOf, sortedSeats } from "./state.ts";
import { copyEvent } from "./text.ts";
import type { Delivered, GatewayState, WakeScheduler } from "./types.ts";
import { isPublicMessage } from "./wake.ts";

// Event delivery (§8.4, §8.6): archive, inbox, public feed, wake triggers. Driven by `ev` lines,
// in their order: the live host calls it with the events of each engine step, the rebuild with the
// event of each `ev` line, and both reach the same state.

function keyText(value: Json | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Whether a public event may wake the `public` role: always, except for a `publicOncePerDay`
 * type whose `${type}:${data.key}:${day}` was already used (the key is then claimed).
 */
function claimPublicWake(gw: GatewayState, rules: GatewayRules, ev: DomainEvent): boolean {
  if (!rules.publicOncePerDay.includes(ev.type)) return true;
  const key = `${ev.type}:${keyText(ev.data.key)}:${dayOf(ev.t)}`;
  if (Object.hasOwn(gw.onceKeys, key)) return false;
  gw.onceKeys[key] = true;
  return true;
}

/**
 * Delivers engine events in order. Each event gets the next delivery number; it is appended to the
 * archive and inbox of every recipient and, when public, to the feed. Wake triggers are ingested
 * per recipient role and, for a public event, with the `public` role for every seat (subject to
 * `publicOncePerDay`); a public message wakes nobody, whatever its audience (`ingest` drops it).
 * A `player_eliminated` event eliminates its player's seat.
 *
 * Events are copied, so the gateway state never aliases an engine object.
 */
export function deliver(
  gw: GatewayState,
  events: readonly DomainEvent[],
  wake: WakeScheduler,
): void {
  for (const source of events) {
    const event = copyEvent(source);
    const seats = event.to.map((r) => seatOf(gw, r.p));
    gw.delivered += 1;
    const d: Delivered = { e: gw.delivered, event };
    for (const s of seats) {
      s.archive.push(d);
      s.inbox.push(d);
    }
    if (event.public) gw.feed.push(d);
    for (const r of event.to) wake.ingest(r.p, event, r.as);
    if (event.public && !isPublicMessage(event) && claimPublicWake(gw, wake.rules, event)) {
      for (const s of sortedSeats(gw)) wake.ingest(s.seat, event, "public");
    }
    if (event.type === "player_eliminated") {
      const player = event.data.player;
      if (typeof player === "string" && isSeat(gw, player)) wake.eliminate(player);
    }
  }
}
