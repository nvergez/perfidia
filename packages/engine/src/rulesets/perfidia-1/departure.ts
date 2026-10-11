import type { DepartureDraft, DepartureVerdict } from "@perfidia/engine/contracts";
import { defaultDeparture, travel } from "@perfidia/engine/std";
import type { Action, CityId, DeepReadonly, PlayerId, Violation } from "@perfidia/protocol";
import { own, type PRead } from "./common.ts";
import { CAPITAL_IMMUNE, CITY_BESIEGED, NOT_BESIEGER } from "./errors.ts";
import { siegeOf, type Siege } from "./ext.ts";

// Launch rules of perfidia-1 beyond the generic checks (§7.3) and the siege guard (§9.2). Every
// check reads own or public data only (sieges are public), so validation stays fog-safe
// (docs/architecture.md §7.2).

function besieged(city: CityId, siege: DeepReadonly<Siege>): Violation {
  return { code: CITY_BESIEGED, details: { city, by: siege.by, endsAt: siege.endsAt } };
}

function reject(violation: Violation): DepartureVerdict {
  return { ok: false, violation };
}

function invalidTarget(d: DepartureDraft, reason: string): DepartureVerdict {
  return reject({ code: "INVALID_TARGET", details: { city: d.to, kind: d.kind, reason } });
}

/**
 * The `CAPITAL_IMMUNE` warning (§9.5): an attack carrying settlers that will land on a capital
 * before `capitalImmunityEnd` is accepted, but a win there is a raid and the settlers come back.
 */
function capitalWarnings(r: PRead, d: DepartureDraft, target: CityId): Violation[] {
  const city = own(r.state.cities, target);
  const from = own(r.state.cities, d.from);
  if (city === undefined || from === undefined || city.capitalOf === null) return [];
  if ((d.units[r.rules.roles.settler] ?? 0) < 1) return [];
  const arriveAt =
    r.now + travel(r, from.island, d.island, { kind: "attack", units: { ...d.units } });
  const immuneUntil = r.config.time.capitalImmunityEnd;
  if (arriveAt >= immuneUntil) return [];
  return [{ code: CAPITAL_IMMUNE, details: { city: target, arriveAt, immuneUntil } }];
}

/**
 * An attack (§7.3): the target is a city the mover does not own, or the mover's own city while it
 * is besieged (relief); never a city the mover besieges itself (send `support` instead). The group
 * must fight: a land unit with attack > 0 or, across water, a warship. Its recorded foe is the
 * besieger when the target is besieged at launch, otherwise the owner (`null`: the neutral Crown).
 */
function attackDeparture(r: PRead, d: DepartureDraft): DepartureVerdict {
  const target = d.to === null ? undefined : own(r.state.cities, d.to);
  if (target === undefined) return invalidTarget(d, "unknown_city");
  const siege = siegeOf(r.ext(), target.id);
  if (siege !== null && siege.by === d.owner) return invalidTarget(d, "besieged_by_you");
  if (siege === null && target.owner === d.owner) return invalidTarget(d, "own_city");
  const from = own(r.state.cities, d.from);
  const crossing = from === undefined || from.island !== d.island;
  const fights = r.rules.units.some(
    (u) =>
      (d.units[u.id] ?? 0) > 0 && (u.domain === "land" ? u.attack > 0 : crossing && u.naval > 0),
  );
  if (!fights) return reject({ code: "NO_UNITS", details: { kind: d.kind, crossing } });
  const party: PlayerId | null = siege === null ? target.owner : siege.by;
  const warnings = siege === null ? capitalWarnings(r, d, target.id) : [];
  return warnings.length === 0 ? { ok: true, party } : { ok: true, party, warnings };
}

/**
 * `hooks.departure` (§7.3): no departure from a besieged city; attacks as above; a support to a
 * besieged city only from its besieger (`NOT_BESIEGER`), recorded with the besieger as its party; no
 * shipment to a besieged city. Everything else follows `std.defaultDeparture`.
 *
 * The besieger's support reinforces its garrison (§9.2), so it skips the "player-owned target"
 * check of §7.3: the neutral Crown is besiegeable like any city (§9.6) and its besieger reinforces
 * it the same way (§7.5). Its origin is not besieged (checked first), so it is not the target.
 */
export function departure(r: PRead, d: DepartureDraft): DepartureVerdict {
  const x = r.ext();
  const origin = siegeOf(x, d.from);
  if (origin !== null) return reject(besieged(d.from, origin));
  if (d.kind === "attack") return attackDeparture(r, d);
  const siege = d.to === null ? null : siegeOf(x, d.to);
  if (d.to === null || siege === null) return defaultDeparture(r, d);
  if (d.kind === "support") {
    if (siege.by !== d.owner) {
      return reject({
        code: NOT_BESIEGER,
        details: { city: d.to, by: siege.by, endsAt: siege.endsAt },
      });
    }
    return { ok: true, party: siege.by };
  }
  if (d.kind === "shipment") return reject(besieged(d.to, siege));
  return defaultDeparture(r, d);
}

/** A seat's own city that is besieged, as the `CITY_BESIEGED` violation; null otherwise. */
function ownBesieged(r: PRead, seat: PlayerId, city: CityId): Violation | null {
  if (own(r.state.cities, city)?.owner !== seat) return null;
  const siege = siegeOf(r.ext(), city);
  return siege === null ? null : besieged(city, siege);
}

/**
 * `hooks.guard` (§9.2): the owner of a besieged city cannot build, recruit or send anything from it,
 * and cannot dismiss its garrison (§7.4). Recalls are allowed: units homed there may come home and
 * fight a homecoming battle, and the besieger may recall its garrison. Only the seat's own cities
 * are checked; anything else is left to the action's own validation.
 */
export function guard(r: PRead, seat: PlayerId, a: Action): Violation | null {
  switch (a.type) {
    case "build":
    case "recruit":
      return ownBesieged(r, seat, a.city);
    case "send_resources":
    case "attack":
    case "support":
    case "spy":
    case "found_city":
      return ownBesieged(r, seat, a.from);
    case "dismiss": {
      const v = ownBesieged(r, seat, a.city);
      return v !== null && v.details["by"] === a.player ? v : null;
    }
    case "cancel_queue":
    case "recall":
    case "recall_stationed":
    case "send_message":
    case "propose":
    case "answer":
    case "leave":
    case "ext":
      break;
  }
  return null;
}
