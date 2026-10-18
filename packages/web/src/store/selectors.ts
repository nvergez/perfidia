import type { Frame, MatchMeta, Moment, SeatInfo, Standing } from "@perfidia/protocol/spectator";
import { standingsOf } from "@perfidia/spectator/reduce";
import { NEUTRAL_COLOR, playerColor, playerShape, type PlayerShape } from "../lib/colors.ts";
import { isPlayerId, type AllianceId } from "../lib/ids.ts";
import { seatLabel } from "../lib/seats.ts";
import type { DominationBloc, DominationView, Skin } from "../skins/index.ts";

// Pure selectors shared by the views (the map and timeline, the board, feed, story, thoughts and
// players). Results derived from a frame are memoised on the frame's own objects (frames share every
// untouched entity), so a selector returns the same object until what it reads changes, which keeps
// Zustand subscriptions and React memoisation quiet.

/** An alliance as frames hold it. */
export type AllianceEnt = NonNullable<Frame["alliances"][AllianceId]>;

/** A one-entry memo on the identity of its inputs. */
export function memoOne<A extends readonly unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let last: { readonly args: A; readonly value: R } | null = null;
  return (...args: A): R => {
    if (
      last !== null &&
      last.args.length === args.length &&
      last.args.every((x, i) => Object.is(x, args[i]))
    ) {
      return last.value;
    }
    last = { args, value: fn(...args) };
    return last.value;
  };
}

/** Seats by id. */
export const seatsById = memoOne((meta: MatchMeta | null): ReadonlyMap<string, SeatInfo> => {
  const out = new Map<string, SeatInfo>();
  for (const s of meta?.seats ?? []) out.set(s.seat, s);
  return out;
});

export function seatOf(meta: MatchMeta | null, seat: string): SeatInfo | null {
  return seatsById(meta).get(seat) ?? null;
}

/** "Odysseus · p1" (the id alone for an unknown seat). */
export function labelOf(meta: MatchMeta | null, player: string): string {
  const s = seatOf(meta, player);
  return s === null ? player : seatLabel(s);
}

/** A player's colour (neutral for `null` or an unknown seat). */
export function colorOf(meta: MatchMeta | null, player: string | null): string {
  if (player === null) return NEUTRAL_COLOR;
  const s = seatOf(meta, player);
  return s === null ? NEUTRAL_COLOR : playerColor(s.color);
}

export function shapeOf(meta: MatchMeta | null, player: string): PlayerShape {
  const s = seatOf(meta, player);
  return playerShape(s?.color ?? 0);
}

const NO_STANDINGS: readonly Standing[] = Object.freeze([]);
let standingsFor: {
  readonly players: Frame["players"];
  readonly value: readonly Standing[];
} | null = null;

/** The standings of a frame (players by rank), memoised on its players. */
export function selectStandings(frame: Frame | null): readonly Standing[] {
  if (frame === null) return NO_STANDINGS;
  if (standingsFor?.players !== frame.players) {
    standingsFor = { players: frame.players, value: standingsOf(frame) };
  }
  return standingsFor.value;
}

/** The alliance a player belongs to in a frame. */
export function allianceOf(frame: Frame | null, player: string): AllianceEnt | null {
  if (frame === null || !isPlayerId(player)) return null;
  const a = frame.players[player]?.alliance ?? null;
  return a === null ? null : (frame.alliances[a] ?? null);
}

const momentsSlice = memoOne((moments: readonly Moment[], n: number): readonly Moment[] =>
  n === moments.length ? moments : moments.slice(0, n),
);

/** Moments up to a cursor: the same array until a moment is passed (or the list changes). */
export function momentsUntil(moments: readonly Moment[], seq: number): readonly Moment[] {
  let lo = 0;
  let hi = moments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((moments[mid]?.seq ?? Number.MAX_SAFE_INTEGER) <= seq) lo = mid + 1;
    else hi = mid;
  }
  return momentsSlice(moments, lo);
}

/** The last moment of one of `kinds` up to a cursor. */
export function lastMoment(
  moments: readonly Moment[],
  seq: number,
  kinds: readonly Moment["k"][],
): Moment | null {
  for (let i = moments.length - 1; i >= 0; i -= 1) {
    const m = moments[i];
    if (m !== undefined && m.seq <= seq && kinds.includes(m.k)) return m;
  }
  return null;
}

let dominationFor: {
  readonly skin: Skin;
  readonly meta: MatchMeta;
  readonly ext: Frame["ext"];
  readonly value: DominationView | null;
} | null = null;

/**
 * The domination view of a frame through its skin, memoised on the frame's `ext` (the skin reads
 * nothing else of the frame): the same object until the blocs or countdowns change.
 */
export function selectDomination(
  skin: Skin | null,
  meta: MatchMeta | null,
  frame: Frame | null,
): DominationView | null {
  if (skin === null || meta === null || frame === null) return null;
  const d = dominationFor;
  if (d !== null && d.skin === skin && d.meta === meta && d.ext === frame.ext) return d.value;
  const value = skin.domination(meta, frame);
  dominationFor = { skin, meta, ext: frame.ext, value };
  return value;
}

/** The bloc a player belongs to. */
export function blocOf(d: DominationView | null, player: string): DominationBloc | null {
  return d?.blocs.find((b) => b.members.some((m) => m === player)) ?? null;
}
