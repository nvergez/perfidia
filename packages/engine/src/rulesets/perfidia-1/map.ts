import { initialExt } from "./ext.ts";
import { NAMES_1_0_0 } from "./names.ts";
import { createWorldWith } from "./world.ts";

// Map generation and the starting state of perfidia-1@1.0.0 (§2.3, §3): `world.ts` with 1.0.0's
// ids. Pure: every draw comes from the named streams `map`, `seats` and `tiebreak`, each requested
// once.

export {
  DOMINATION_OPEN,
  drawMap,
  hasHubs,
  islandsPerSector,
  layoutIslands,
  sectorIslandId,
  type Jitter,
  type LaidIsland,
  type MapDraws,
} from "./world.ts";

/**
 * `hooks.createWorld` (§2.3, §3): the islands, the capitals `c1..cN` in slot 0 of their seat's home
 * island, the neutral Crown `c(N+1)`, the public tie-break order, and the `domination_open` timer.
 */
export const createWorld = createWorldWith(NAMES_1_0_0, initialExt);
