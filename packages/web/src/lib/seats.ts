import type { SeatInfo } from "@perfidia/protocol/spectator";

// How a seat is named (phase-3 design §4.1): the name first, the id always visible, "Odysseus · p1".
// Agents quote ids, so the id is never hidden behind a name.

/** "Odysseus · p1". */
export function seatLabel(seat: Pick<SeatInfo, "seat" | "name">): string {
  return `${seat.name} · ${seat.seat}`;
}

/** The label of a player id, from the seats when known ("p7" alone otherwise). */
export function playerLabel(seats: readonly SeatInfo[], player: string): string {
  const s = seats.find((x) => x.seat === player);
  return s === undefined ? player : seatLabel(s);
}
