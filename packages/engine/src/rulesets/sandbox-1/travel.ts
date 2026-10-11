import type { ReadCtx } from "@perfidia/engine/contracts";
import type { DeepReadonly, Island, IslandId, TravelGroup } from "@perfidia/protocol";
import type { SandboxConfig } from "./config.ts";
import type { SandboxExt } from "./ext.ts";
import { ringDistance, ringWidth, type Point } from "./map.ts";

// Travel times (docs/architecture.md §3.8): `time.minTravel + travel.perTile · d` for every movement
// kind, d the ring distance; on one island d = 0, so a trip takes exactly `time.minTravel`. Every
// trip therefore lasts ≥ `time.minTravel` (the speed rule, checked at creation for the probe).

/** Travel time in seconds between two points of a map of N players. */
export function travelBetween(
  config: DeepReadonly<SandboxConfig>,
  players: number,
  a: Point,
  b: Point,
): number {
  return (
    config.time.minTravel + config.travel.perTile * ringDistance(a, b, ringWidth(config, players))
  );
}

function islandOf(r: ReadCtx<SandboxConfig, SandboxExt>, id: IslandId): DeepReadonly<Island> {
  const island = Object.hasOwn(r.state.islands, id) ? r.state.islands[id] : undefined;
  if (island === undefined) throw new RangeError(`travelTime: island ${id} does not exist`);
  return island;
}

/** `hooks.travelTime`: the same for every group. */
export function travelTime(
  r: ReadCtx<SandboxConfig, SandboxExt>,
  from: IslandId,
  to: IslandId,
  _group: TravelGroup,
): number {
  return travelBetween(r.config, r.rules.players, islandOf(r, from), islandOf(r, to));
}
