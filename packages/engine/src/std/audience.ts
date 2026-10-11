// Event audiences (docs/architecture.md §8.6). Audiences are computed when the event happens, with
// the ruleset's relations; `defaultVisibility` grants movement access to exactly the same players,
// so notifications and projections follow one policy.

import {
  ROLES,
  compareIds,
  type MovementId,
  type PlayerId,
  type Recipient,
  type Role,
} from "@perfidia/protocol";
import type { ReadCtx } from "@perfidia/engine/contracts";
import { relationsOf } from "./derive.ts";
import { readMovement } from "./util.ts";

/**
 * One recipient per player, each with the first role in the priority order party, self, target,
 * stationed, ally (§8.6). `null` players and `exclude`d players are dropped. Ordered by role, then
 * by player (`compareIds`), so the result never depends on the order of `entries`.
 */
export function recipients(
  entries: Iterable<readonly [PlayerId | null, Role]>,
  exclude: readonly PlayerId[] = [],
): Recipient[] {
  const best: { p: PlayerId; rank: number }[] = [];
  for (const [p, role] of entries) {
    if (p === null || exclude.includes(p)) continue;
    const rank = ROLES.indexOf(role);
    const prev = best.find((x) => x.p === p);
    if (prev === undefined) best.push({ p, rank });
    else if (rank < prev.rank) prev.rank = rank;
  }
  return best
    .toSorted((a, b) => a.rank - b.rank || compareIds(a.p, b.p))
    .map(({ p, rank }) => ({ p, as: ROLES[rank] ?? "ally" }));
}

/**
 * The players told about a movement in flight, never its mover (perfidia-1 §12, without sieges):
 *
 * - `attack`: the recorded foe (`party`), the target city's owner when it is not the foe
 *   (`target`), owners of groups stationed there (`stationed`) and the owner's allies (`ally`);
 * - `support`, `shipment`: the recorded party, the city's owner and the owner's allies;
 * - `return` heading into a held home (§5.4): the owners of the `hold` groups there, as `party`
 *   (a coming homecoming battle); any other return: nobody;
 * - `spy`, `found`: nobody.
 */
export function incomingAudience(r: ReadCtx, m: MovementId): Recipient[] {
  const mv = readMovement(r.state, m);
  const entries: [PlayerId | null, Role][] = [];
  if (mv.kind === "return") {
    const home = r.state.cities[mv.home];
    for (const g of home?.stationed ?? []) {
      if (g.role === "hold") entries.push([g.owner, "party"]);
    }
    return recipients(entries, [mv.owner]);
  }
  if (mv.kind === "spy" || mv.kind === "found" || mv.to === null) return [];
  const city = r.state.cities[mv.to];
  if (city === undefined) return [];
  entries.push([mv.party, "party"], [city.owner, "target"]);
  if (mv.kind === "attack") for (const g of city.stationed) entries.push([g.owner, "stationed"]);
  if (city.owner !== null) {
    for (const rel of relationsOf(r, city.owner)) {
      if (rel.kind === "ally") entries.push([rel.player, "ally"]);
    }
  }
  return recipients(entries, [mv.owner]);
}
