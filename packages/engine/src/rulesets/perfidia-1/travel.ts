import type { ReadCtx } from "@perfidia/engine/contracts";
import { isqrt } from "@perfidia/engine/core";
import type { DeepReadonly, IslandId, TravelGroup } from "@perfidia/protocol";
import type { PerfidiaCore } from "./config.ts";

// Travel times (perfidia-1 §7.2). `time.minTravel` and `time.sameIslandTravel` come from the config,
// never as a literal.

/** Integer tile coordinates. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Squared distance in tiles. */
export function distance2(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** The distance shown to agents: `isqrt(d²)` tiles (§2.3). */
export function distanceTiles(a: Point, b: Point): number {
  return isqrt(distance2(a, b));
}

/**
 * Seconds per tile of a group (§7.2): spies and shipments have their own pace; otherwise the
 * slowest ship of the group, or the homebound pace for a group with no ship.
 */
export function paceOf(
  config: DeepReadonly<PerfidiaCore>,
  group: DeepReadonly<TravelGroup>,
): number {
  if (group.kind === "spy") return config.movement.spyPace;
  if (group.kind === "shipment") return config.movement.shipment.pace;
  let pace: number | null = null;
  for (const [id, u] of Object.entries(config.units)) {
    const n = group.units[id] ?? 0;
    if (n > 0 && u.domain === "naval") {
      const p = u.seaPace ?? config.movement.homeboundPace;
      pace = pace === null ? p : Math.max(pace, p);
    }
  }
  return pace ?? config.movement.homeboundPace;
}

/**
 * `travel(A, B, pace)`: `sameIslandTravel` on the same island, otherwise
 * `max(minTravel, isqrt(pace² · d²))`.
 */
export function travelBetween(
  config: DeepReadonly<PerfidiaCore>,
  from: Point,
  to: Point,
  sameIsland: boolean,
  group: DeepReadonly<TravelGroup>,
): number {
  if (sameIsland) return config.time.sameIslandTravel;
  const pace = paceOf(config, group);
  return Math.max(config.time.minTravel, isqrt(pace * pace * distance2(from, to)));
}

/** `hooks.travelTime`: the travel time between two islands of the match for a group. */
export function travelTime<X>(
  r: ReadCtx<PerfidiaCore, X>,
  from: IslandId,
  to: IslandId,
  group: TravelGroup,
): number {
  const a = r.state.islands[from];
  const b = r.state.islands[to];
  if (a === undefined || b === undefined) {
    throw new RangeError(`travelTime: unknown island ${a === undefined ? from : to}`);
  }
  return travelBetween(r.config, a, b, from === to, group);
}
