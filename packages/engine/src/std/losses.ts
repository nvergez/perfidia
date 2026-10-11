// Loss allocation over split stacks (perfidia-1 §8.3, docs/architecture.md §5.4). A stack is one
// owner's units of one type in a battle; its units can sit in several groups (at home, and one
// stationed group per home city and role). Losses are computed on the merged stack and allocated
// to the groups by largest remainder.

import type { CityId, PlayerId, UnitCounts } from "@perfidia/protocol";
import { assertSafeInt, floorDiv } from "@perfidia/engine/core";
import type { ReadCtx } from "@perfidia/engine/contracts";
import { unitsAtHome } from "./derive.ts";
import type { UnitSlot } from "./units.ts";
import { cleanUnits, fail, readCity } from "./util.ts";

/**
 * The groups of `owner`'s units in the city, in allocation order: units at home first (only for
 * the city's owner, `null` meaning a neutral city), then its stationed groups by home city, then
 * role (the stored order, §4.2). A slot may hold none of a given unit type.
 */
export function stackGroups(r: ReadCtx, city: CityId, owner: PlayerId | null): UnitSlot[] {
  const c = readCity(r.state, city);
  const out: UnitSlot[] = [];
  if (c.owner === owner) out.push({ at: "home", city });
  if (owner === null) return out;
  for (const g of c.stationed) {
    if (g.owner === owner) out.push({ at: "stationed", city, owner, home: g.home, role: g.role });
  }
  return out;
}

/**
 * The units in a slot, as a fresh object: at home including trickled units completed by now, a
 * stationed group (empty if it does not exist), or a movement.
 */
export function slotUnits(r: ReadCtx, slot: UnitSlot): UnitCounts {
  if (slot.at === "home") return unitsAtHome(r, slot.city);
  if (slot.at === "stationed") {
    const g = readCity(r.state, slot.city).stationed.find(
      (x) => x.owner === slot.owner && x.home === slot.home && x.role === slot.role,
    );
    return g === undefined ? {} : cleanUnits(r.rules, g.units);
  }
  const m = r.state.movements[slot.id];
  return m === undefined ? {} : cleanUnits(r.rules, m.units);
}

/**
 * Allocates `loss` units over groups of sizes `groupSizes` by largest remainder: group i first
 * loses `floor(loss · g_i / n)`, then the remaining losses go one per group in descending order of
 * `(loss · g_i) mod n`, ties to the earlier group. The result sums to `loss`, and no group loses
 * more than it has. Throws when `loss` exceeds the total.
 */
export function allocateLosses(groupSizes: readonly number[], loss: number): number[] {
  assertSafeInt(loss, "loss");
  let n = 0;
  for (const g of groupSizes) {
    assertSafeInt(g, "group size");
    if (g < 0) fail(`group size must be ≥ 0, got ${g}`);
    n += g;
  }
  if (loss < 0 || loss > n) fail(`cannot allocate ${loss} losses over ${n} units`);
  if (loss === 0) return groupSizes.map(() => 0);
  const out: number[] = [];
  const rem: number[] = [];
  let given = 0;
  for (const g of groupSizes) {
    const p = assertSafeInt(loss * g, "loss allocation product");
    const base = floorDiv(p, n);
    out.push(base);
    rem.push(p - base * n);
    given += base;
  }
  const order = groupSizes.map((_, i) => i);
  order.sort((a, b) => (rem[b] ?? 0) - (rem[a] ?? 0) || a - b);
  for (let k = 0; k < loss - given; k += 1) {
    const i = order[k];
    if (i === undefined) fail("loss allocation ran out of groups");
    out[i] = (out[i] ?? 0) + 1;
  }
  return out;
}
