// Ruleset-independent defaults for fog of war (perfidia-1 §12 without sieges) and departures
// (perfidia-1 §7.3 without sieges). Rulesets override parts through `hooks.visibility` and
// `hooks.departure`; the gateway and the domain fall back to these.

import type {
  City,
  CityId,
  DeepReadonly,
  IslandId,
  MovementId,
  PlayerId,
  Violation,
} from "@perfidia/protocol";
import type {
  DepartureDraft,
  DepartureVerdict,
  ReadCtx,
  Visibility,
} from "@perfidia/engine/contracts";
import { incomingAudience } from "./audience.ts";
import { freeSlots, inFlightCargo, insufficientResources, relation } from "./derive.ts";
import { levelOf, resTotal, unitTable } from "./util.ts";

/**
 * - `cityAccess`: `full` for the owner and the owner's allies (live shared vision), `public`
 *   otherwise, and for neutral cities;
 * - `movementAccess`: `own` for the mover; for anyone in the movement's `incomingAudience`,
 *   `full` for supports and shipments and `incoming` (no composition) for attacks and for returns
 *   heading into a held home; `null` otherwise (spies and founders are seen by the sender only);
 * - no public extras, and no `briefing` (the gateway falls back to `publicMatch`).
 */
export const defaultVisibility: Visibility<unknown, unknown> = Object.freeze({
  cityAccess(r: ReadCtx, viewer: PlayerId, city: CityId): "full" | "public" {
    const owner = r.state.cities[city]?.owner ?? null;
    if (owner === null) return "public";
    const rel = relation(r, viewer, owner);
    return rel === "self" || rel === "ally" ? "full" : "public";
  },
  movementAccess(r: ReadCtx, viewer: PlayerId, m: MovementId): "own" | "full" | "incoming" | null {
    const mv = r.state.movements[m];
    if (mv === undefined) return null;
    if (mv.owner === viewer) return "own";
    if (!incomingAudience(r, m).some((x) => x.p === viewer)) return null;
    return mv.kind === "support" || mv.kind === "shipment" ? "full" : "incoming";
  },
  publicCity: () => ({}),
  publicPlayer: () => ({}),
  publicMatch: () => ({}),
});

function reject(code: string, details: Violation["details"]): DepartureVerdict {
  return { ok: false, violation: { code, details } };
}

function originIsland(r: ReadCtx, d: DepartureDraft): IslandId | null {
  const from = r.state.cities[d.from];
  return from === undefined ? null : from.island;
}

type Target = DeepReadonly<City> | undefined;
type KindRule = (r: ReadCtx, d: DepartureDraft, target: Target) => DepartureVerdict;

const DEPARTURE_RULES: Readonly<Record<DepartureDraft["kind"], KindRule>> = Object.freeze({
  attack(r: ReadCtx, d: DepartureDraft, target: Target): DepartureVerdict {
    if (target === undefined || target.owner === d.owner) {
      return reject("INVALID_TARGET", { city: d.to, kind: d.kind });
    }
    const crossing = originIsland(r, d) !== d.island;
    const fights = Object.keys(d.units).some((id) => {
      if ((d.units[id] ?? 0) <= 0) return false;
      const u = unitTable(r.rules, id);
      return u.domain === "land" ? u.attack > 0 : crossing && u.naval > 0;
    });
    if (!fights) return reject("NO_UNITS", { kind: d.kind, crossing });
    return { ok: true, party: target.owner };
  },
  support(_r: ReadCtx, d: DepartureDraft, target: Target): DepartureVerdict {
    if (target === undefined || target.owner === null || d.to === d.from) {
      return reject("INVALID_TARGET", { city: d.to, kind: d.kind });
    }
    return { ok: true, party: target.owner };
  },
  found(r: ReadCtx, d: DepartureDraft): DepartureVerdict {
    const island = r.state.islands[d.island];
    if (island === undefined) return reject("INVALID_TARGET", { island: d.island, kind: d.kind });
    if (d.slot !== null && (d.slot < 0 || d.slot >= island.slots)) {
      return reject("INVALID_ARGS", { island: d.island, slot: d.slot, slots: island.slots });
    }
    if (freeSlots(r, d.island).length === 0) return reject("NO_FREE_SLOT", { island: d.island });
    const founder = r.rules.roles.settler;
    if ((d.units[founder] ?? 0) < 1) return reject("SETTLER_REQUIRED", { unit: founder });
    return { ok: true, party: null };
  },
  spy(r: ReadCtx, d: DepartureDraft, target: Target): DepartureVerdict {
    if (target === undefined || target.owner === d.owner) {
      return reject("INVALID_TARGET", { city: d.to, kind: d.kind });
    }
    const min = r.rules.movement.spyMinGold;
    if (d.gold < min) return reject("SPY_GOLD", { min, gold: d.gold });
    const short = insufficientResources(r, d.from, { wood: 0, stone: 0, gold: d.gold });
    if (short !== null) return { ok: false, violation: short };
    return { ok: true, party: target.owner };
  },
  shipment(r: ReadCtx, d: DepartureDraft, target: Target): DepartureVerdict {
    if (target === undefined || target.owner === null || d.to === d.from) {
      return reject("INVALID_TARGET", { city: d.to, kind: d.kind });
    }
    const load = resTotal(d.cargo);
    if (load < 1) return reject("INVALID_ARGS", { load });
    const short = insufficientResources(r, d.from, d.cargo);
    if (short !== null) return { ok: false, violation: short };
    const rule = r.rules.movement.shipment;
    const from = r.state.cities[d.from];
    if (rule !== null && from !== undefined) {
      const cap = rule.base + rule.perLevel * levelOf(from, rule.building);
      const inFlight = inFlightCargo(r, d.from);
      if (inFlight + load > cap) {
        return reject("SHIPMENT_CAPACITY", { city: d.from, cap, inFlight, requested: load });
      }
    }
    return { ok: true, party: target.owner };
  },
});

/**
 * The kind-specific departure rules of perfidia-1 §7.3 without sieges, with the recorded party.
 * The generic checks (own origin, units at home, transport rule, `attackFrom`, match end) are the
 * domain's and run before. Every check reads own or public data only (fog-safe, §7.2).
 *
 * - attack: the target is a city the mover does not own; the group has a land unit with attack > 0
 *   or, across water, a naval unit with naval strength > 0. Party: the target's owner (`null`:
 *   neutral).
 * - support: the target is a player-owned city other than the origin. Party: its owner.
 * - found: the island has a free slot now and a requested slot exists; the group has a founding
 *   unit. Party: `null`.
 * - spy: the target is a city the mover does not own; `spyMinGold ≤ gold ≤` the gold in stock.
 *   Party: the target's owner.
 * - shipment: the target is a player-owned city other than the origin; the load is ≥ 1 and in
 *   stock; the cargo in flight plus this one fits `movement.shipment`. Party: the target's owner.
 */
export function defaultDeparture(r: ReadCtx, d: DepartureDraft): DepartureVerdict {
  const target = d.to === null ? undefined : r.state.cities[d.to];
  return DEPARTURE_RULES[d.kind](r, d, target);
}
