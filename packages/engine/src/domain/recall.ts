// Recalls (docs/architecture.md §7.1, §7.4, §5.4; perfidia-1 §7.4, generic parts): `recall` of a
// movement within its window, `recall_stationed` of own stationed groups (whole or partial per
// `movement.recall.stationed`, `AMBIGUOUS_GROUP` when a partial recall does not name the home of one
// of several groups) and `dismiss` of another player's support groups. Every group travels home as
// its own return.

import type { ActionHandler, Ctx, ReadCtx } from "@perfidia/engine/contracts";
import { startReturn, turnBack, unstation } from "@perfidia/engine/std";
import {
  compareIds,
  type ActionOf,
  type CityId,
  type DeepReadonly,
  type MovementId,
  type PlayerId,
  type Stationed,
  type UnitCounts,
} from "@perfidia/protocol";
import {
  canonicalUnits,
  lookup,
  need,
  ownCity,
  pair,
  reject,
  unknownUnit,
  type Verdict,
} from "./common.ts";

/** One group to send home: its owner's units homed in `home`, stationed in the plan's city. */
export interface GroupReturn {
  readonly home: CityId;
  readonly units: UnitCounts;
}

/** The returns a recall created, as the tool result lists them. */
function returnData(ctx: Ctx, ids: readonly MovementId[]) {
  return ids.map((id) => {
    const m = need(ctx.state.movements, id, "movement");
    return { movement: id, home: m.home, arrive: pair(m.arriveAt) };
  });
}

/**
 * `owner`'s groups in the city by home (both roles merged unless `role` is given), homes in id
 * order, units in the canonical unit order.
 */
function groupsByHome(
  r: ReadCtx,
  stationed: readonly DeepReadonly<Stationed>[],
  owner: PlayerId,
  role?: Stationed["role"],
): GroupReturn[] {
  const out: { home: CityId; units: UnitCounts }[] = [];
  const mine = stationed
    .filter((g) => g.owner === owner && (role === undefined || g.role === role))
    .toSorted((a, b) => compareIds(a.home, b.home));
  for (const g of mine) {
    let entry = out.find((x) => x.home === g.home);
    if (entry === undefined) {
      entry = { home: g.home, units: {} };
      out.push(entry);
    }
    for (const u of r.rules.units) {
      const n = g.units[u.id] ?? 0;
      if (n > 0) entry.units[u.id] = (entry.units[u.id] ?? 0) + n;
    }
  }
  return out.map((g) => ({ home: g.home, units: canonicalUnits(r, g.units) }));
}

/** Takes each group out of the city and starts its return home; returns the new movement ids. */
function sendGroupsHome(
  ctx: Ctx,
  city: CityId,
  owner: PlayerId,
  groups: readonly GroupReturn[],
  role?: Stationed["role"],
): MovementId[] {
  const ids: MovementId[] = [];
  for (const g of groups) {
    const units = unstation(ctx, city, owner, g.home, g.units, role);
    ids.push(startReturn(ctx, { owner, home: g.home, from: city, units }));
  }
  return ids;
}

// recall -----------------------------------------------------------------------------------------

export interface RecallPlan {
  readonly movement: MovementId;
}

/**
 * `recall {movement}`: an own movement of a kind in `movement.recall.kinds`, at most
 * `movement.recall.window` seconds after its departure, turns back as a whole (`std.turnBack`:
 * home at `now + max(1, now − departAt)`, or `max(minTravel, …)` into a held home). Another
 * player's movement answers exactly like a missing one (`UNKNOWN_ID`).
 */
export const recall: ActionHandler<ActionOf<"recall">, RecallPlan> = {
  validate(r, seat, a): Verdict<RecallPlan> {
    const m = lookup(r.state.movements, a.movement);
    if (m === undefined || m.owner !== seat) return reject("UNKNOWN_ID", { movement: a.movement });
    const rule = r.rules.movement.recall;
    const kinds: readonly string[] = rule.kinds;
    const recallable = m.kind !== "return" && kinds.includes(m.kind);
    if (!recallable || r.now - m.departAt > rule.window) {
      return reject("NOT_RECALLABLE", {
        movement: a.movement,
        kind: m.kind,
        window: rule.window,
        departAt: m.departAt,
        recallableUntil: recallable ? m.departAt + rule.window : null,
      });
    }
    return { ok: true, plan: { movement: a.movement } };
  },
  apply(ctx, _seat, plan) {
    turnBack(ctx, plan.movement);
    return { returns: returnData(ctx, [plan.movement]) };
  },
};

// recall_stationed -------------------------------------------------------------------------------

export interface RecallStationedPlan {
  readonly at: CityId;
  readonly groups: readonly GroupReturn[];
}

/**
 * `recall_stationed {at, home, units}`: the seat's units stationed in `at` (support groups and its
 * own `hold` groups) go home, one return per home. `units: null` recalls the named group whole, or
 * every group there when no home is named. A unit list needs `movement.recall.stationed =
 * "partial"` and, when the seat has groups from several homes there, `home` (`AMBIGUOUS_GROUP`
 * otherwise, listing the homes).
 */
export const recallStationed: ActionHandler<ActionOf<"recall_stationed">, RecallStationedPlan> = {
  validate(r, seat, a): Verdict<RecallStationedPlan> {
    const city = lookup(r.state.cities, a.at);
    if (city === undefined) return reject("UNKNOWN_ID", { city: a.at });
    if (a.home !== null && lookup(r.state.cities, a.home) === undefined) {
      return reject("UNKNOWN_ID", { city: a.home });
    }
    const mode = r.rules.movement.recall.stationed;
    if (mode === "none") return reject("NOT_RECALLABLE", { city: a.at, stationed: mode });
    const groups = groupsByHome(r, city.stationed, seat);
    const named = a.home === null ? undefined : groups.find((g) => g.home === a.home);
    if (groups.length === 0 || (a.home !== null && named === undefined)) {
      return reject("NOTHING_STATIONED", { city: a.at, home: a.home });
    }
    if (a.units === null) {
      return { ok: true, plan: { at: a.at, groups: named === undefined ? groups : [named] } };
    }
    if (mode === "whole") {
      return reject("NOT_RECALLABLE", { city: a.at, stationed: mode, reason: "whole_only" });
    }
    const unknown = unknownUnit(r, a.units);
    if (unknown !== null) return reject("INVALID_ARGS", { unit: unknown, reason: "unknown_unit" });
    const units = canonicalUnits(r, a.units);
    if (Object.keys(units).length === 0) return reject("NO_UNITS", { city: a.at });
    if (named === undefined && groups.length > 1) {
      return reject("AMBIGUOUS_GROUP", {
        city: a.at,
        groups: groups.length,
        homes: groups.map((g) => g.home).join(","),
      });
    }
    const group = named ?? groups[0];
    if (group === undefined) return reject("NOTHING_STATIONED", { city: a.at, home: a.home });
    for (const u of r.rules.units) {
      const requested = units[u.id] ?? 0;
      const stationed = group.units[u.id] ?? 0;
      if (requested > stationed) {
        return reject("INSUFFICIENT_UNITS", {
          city: a.at,
          from: group.home,
          unit: u.id,
          requested,
          stationed,
        });
      }
    }
    return { ok: true, plan: { at: a.at, groups: [{ home: group.home, units }] } };
  },
  apply(ctx, seat, plan) {
    return { returns: returnData(ctx, sendGroupsHome(ctx, plan.at, seat, plan.groups)) };
  },
};

// dismiss ----------------------------------------------------------------------------------------

export interface DismissPlan {
  readonly city: CityId;
  readonly player: PlayerId;
  readonly groups: readonly GroupReturn[];
}

/**
 * `dismiss {city, player}`: the owner of a city sends home every support group of `player`
 * stationed in it (one return per home), when `movement.recall.dismiss` allows it. `hold` groups
 * (siege garrisons) cannot be dismissed. The dismissed player is told with `movement_recalled`
 * (`dismissed: true`) for each return.
 */
export const dismiss: ActionHandler<ActionOf<"dismiss">, DismissPlan> = {
  validate(r, seat, a): Verdict<DismissPlan> {
    if (!r.rules.movement.recall.dismiss) {
      return reject("NOT_RECALLABLE", { city: a.city, player: a.player, dismiss: false });
    }
    const own = ownCity(r, seat, a.city);
    if (!own.ok) return own;
    if (lookup(r.state.players, a.player) === undefined) {
      return reject("UNKNOWN_ID", { player: a.player });
    }
    if (a.player === seat) return reject("INVALID_TARGET", { player: a.player, city: a.city });
    const groups = groupsByHome(r, own.city.stationed, a.player, "support");
    if (groups.length === 0) {
      return reject("NOTHING_STATIONED", { city: a.city, player: a.player });
    }
    return { ok: true, plan: { city: a.city, player: a.player, groups } };
  },
  apply(ctx, seat, plan) {
    const ids = sendGroupsHome(ctx, plan.city, plan.player, plan.groups, "support");
    for (const id of ids) {
      const m = need(ctx.state.movements, id, "movement");
      ctx.emit({
        type: "movement_recalled",
        public: false,
        to: [{ p: plan.player, as: "self" }],
        data: {
          movement: id,
          kind: "support",
          by: plan.player,
          to: plan.city,
          arriveAt: m.arriveAt,
          dismissed: true,
          dismissedBy: seat,
        },
      });
    }
    return { returns: returnData(ctx, ids) };
  },
};
