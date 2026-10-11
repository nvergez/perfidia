// Unit primitives (docs/architecture.md §5.4). Units are made and destroyed only through
// `spawnUnits` (`ledger.made`) and `removeUnits` (`ledger.gone`); every other primitive moves them
// between home, stationed groups and movements of the same owner, so unit conservation (§13.3)
// holds by construction.

import type { CityId, MovementId, PlayerId, UnitCounts } from "@perfidia/protocol";
import type { Ctx } from "@perfidia/engine/contracts";
import { materialize } from "./stock.ts";
import { addInto, draftCity, draftMovement, fail, ledgerOf, takeFrom } from "./util.ts";

/** Where units are: at home in a city, in a stationed group, or in a movement. */
export type UnitSlot =
  | { readonly at: "home"; readonly city: CityId }
  | {
      readonly at: "stationed";
      readonly city: CityId;
      readonly owner: PlayerId;
      readonly home: CityId;
      readonly role: "support" | "hold";
    }
  | { readonly at: "movement"; readonly id: MovementId };

/** New units at home in the city, for its owner (`ledger.made`; neutral for a neutral city). */
export function spawnUnits(ctx: Ctx, city: CityId, units: Readonly<UnitCounts>): void {
  materialize(ctx, city);
  const c = draftCity(ctx, city);
  addInto(ctx.rules, c.units, units);
  addInto(ctx.rules, ledgerOf(ctx, c.owner).made, units);
}

/** Takes units from the owner's units at home, for a departure. Throws on a shortfall. */
export function takeHome(ctx: Ctx, city: CityId, units: Readonly<UnitCounts>): void {
  materialize(ctx, city);
  takeFrom(ctx.rules, draftCity(ctx, city).units, units, `units at home in ${city}`);
}

/**
 * Puts units of the city's owner at home there without touching the ledger: units coming home or
 * re-homed into the city, taken by the caller from a movement or a stationed group.
 */
export function putHome(ctx: Ctx, city: CityId, units: Readonly<UnitCounts>): void {
  materialize(ctx, city);
  addInto(ctx.rules, draftCity(ctx, city).units, units);
}

/**
 * Destroys units in a slot (`ledger.gone` of their owner). A stationed group left empty is removed;
 * a movement left empty stays (its handler ends or deletes it). Throws on a shortfall.
 */
export function removeUnits(
  ctx: Ctx,
  where: UnitSlot,
  units: Readonly<UnitCounts>,
  why: "killed" | "consumed" | "disbanded",
): void {
  const what = `${why} units`;
  switch (where.at) {
    case "home": {
      materialize(ctx, where.city);
      const c = draftCity(ctx, where.city);
      takeFrom(ctx.rules, c.units, units, `${what} at home in ${where.city}`);
      addInto(ctx.rules, ledgerOf(ctx, c.owner).gone, units);
      return;
    }
    case "stationed": {
      const c = draftCity(ctx, where.city);
      const i = c.stationed.findIndex(
        (g) => g.owner === where.owner && g.home === where.home && g.role === where.role,
      );
      const g = c.stationed[i];
      if (g === undefined) {
        fail(
          `${what}: no ${where.role} group of ${where.owner} from ${where.home} in ${where.city}`,
        );
      }
      takeFrom(ctx.rules, g.units, units, `${what} stationed in ${where.city}`);
      if (Object.keys(g.units).length === 0) c.stationed.splice(i, 1);
      addInto(ctx.rules, ledgerOf(ctx, g.owner).gone, units);
      return;
    }
    case "movement": {
      const m = draftMovement(ctx, where.id);
      takeFrom(ctx.rules, m.units, units, `${what} in ${where.id}`);
      addInto(ctx.rules, ledgerOf(ctx, m.owner).gone, units);
      return;
    }
  }
}
