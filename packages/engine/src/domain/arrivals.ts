// Default arrivals (docs/architecture.md §5.1 "Dispatch"; perfidia-1 §7.5, without sieges): support,
// shipment, found and return. `attack` and `spy` are always the ruleset's. A ruleset with sieges
// replaces the ones it needs (`hooks.arrive`); these know nothing of `hold` groups.

import type { Ctx } from "@perfidia/engine/contracts";
import {
  arriveHome,
  bounce,
  deleteMovement,
  deliverShipment,
  deliverSupport,
  foundCity,
  freeSlots,
  removeUnits,
} from "@perfidia/engine/std";
import type { MovementId } from "@perfidia/protocol";
import { lookup, need } from "./common.ts";

/** The target city's owner, or null when the target is gone or neutral. */
function targetOwner(ctx: Ctx, m: MovementId): string | null {
  const mv = need(ctx.state.movements, m, "movement");
  if (mv.to === null) return null;
  return lookup(ctx.state.cities, mv.to)?.owner ?? null;
}

/**
 * A support arrives: when the target is still owned by the party recorded at launch, the units are
 * stationed there (merged into the group of mover and home, `std.deliverSupport`); otherwise the
 * movement bounces home (`owner_changed`). A support whose target became its own home (its origin
 * was lost and it was re-homed to its target, §7.7 of perfidia-1) simply arrives home.
 */
export function arriveSupport(ctx: Ctx, m: MovementId): void {
  const mv = need(ctx.state.movements, m, "movement");
  const owner = targetOwner(ctx, m);
  if (owner !== null && owner === mv.owner && mv.to === mv.home) arriveHome(ctx, m);
  else if (owner !== null && owner === mv.party) deliverSupport(ctx, m);
  else bounce(ctx, m, "owner_changed");
}

/**
 * A shipment arrives: when the target is still owned by the party recorded at launch, the cargo is
 * delivered capped by storage (`std.deliverShipment`: the amounts and the overflow lost to the
 * recipient, the outcome only to the sender); otherwise it bounces home with its cargo
 * (`owner_changed`), and counts in its origin's in-flight cargo until it is back.
 */
export function arriveShipment(ctx: Ctx, m: MovementId): void {
  const mv = need(ctx.state.movements, m, "movement");
  const owner = targetOwner(ctx, m);
  if (owner !== null && owner === mv.party) deliverShipment(ctx, m);
  else bounce(ctx, m, "owner_changed");
}

/**
 * A founding arrives: with a free slot on the island (the requested one when free, with
 * `toolOptions.foundSlot`, else the lowest), one founding unit is consumed and a new city is founded
 * there; the rest of the group (escort, ships, extra founders) is re-homed to it. Without a free
 * slot, or without a founding unit left, it bounces home (`no_free_slot`, `no_settler`).
 */
export function arriveFound(ctx: Ctx, m: MovementId): void {
  const mv = need(ctx.state.movements, m, "movement");
  const settler = ctx.rules.roles.settler;
  if (freeSlots(ctx.read(), mv.toIsland).length === 0) {
    bounce(ctx, m, "no_free_slot");
    return;
  }
  if ((mv.units[settler] ?? 0) < 1) {
    bounce(ctx, m, "no_settler");
    return;
  }
  removeUnits(ctx, { at: "movement", id: m }, { [settler]: 1 }, "consumed");
  const escort = { ...mv.units };
  mv.units = {};
  const slot = ctx.rules.toolOptions.foundSlot ? mv.slot : null;
  foundCity(ctx, mv.toIsland, mv.owner, escort, slot);
  deleteMovement(ctx, m);
}

/** A return arrives home: units at home, cargo added capped (`returned`, with any overflow lost). */
export function arriveReturn(ctx: Ctx, m: MovementId): void {
  arriveHome(ctx, m);
}
