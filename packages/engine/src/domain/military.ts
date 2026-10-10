// Departures (docs/architecture.md §7.1, §3.4; perfidia-1 §6.4, §7.3, generic parts): `attack`,
// `support`, `spy`, `found_city` and `send_resources`. The generic checks run first (own origin,
// target ids, the `slot` tool option, `attackFrom`, units at home, the transport rule); then the
// ruleset's `hooks.departure`, or `std.defaultDeparture`, decides the kind-specific rules and the
// recorded party, with its warnings; then the stock pays the cargo and the spy gold. `apply`
// launches through `std.launch`, which schedules the arrival and emits the incoming notices.

import type {
  ActionHandler,
  Ctx,
  DepartureDraft,
  DepartureVerdict,
  ReadCtx,
} from "@perfidia/engine/contracts";
import { defaultDeparture, launch, sortedIds } from "@perfidia/engine/std";
import type {
  ActionOf,
  City,
  CityId,
  DeepReadonly,
  GameTime,
  IslandId,
  Movement,
  PlayerId,
  Res,
  UnitCounts,
  Violation,
} from "@perfidia/protocol";
import {
  canonicalUnits,
  lookup,
  need,
  ownCity,
  pair,
  reject,
  shortOf,
  unitShortage,
  unknownUnit,
  type Rejection,
  type Verdict,
} from "./common.ts";

export interface LaunchPlan {
  /** The departure as validated, with the group the verdict settled on. */
  readonly draft: DepartureDraft;
  /** The recorded foe or party (`null`: neutral or not applicable). */
  readonly party: PlayerId | null;
}

interface DepartureInput {
  readonly kind: DepartureDraft["kind"];
  readonly from: CityId;
  /** Target city; `null` for found. */
  readonly to: CityId | null;
  /** Target island for found. */
  readonly island: IslandId | null;
  readonly slot: number | null;
  readonly units: Readonly<UnitCounts>;
  readonly cargo: Readonly<Res>;
  readonly gold: number;
}

const NO_RES: Res = { wood: 0, stone: 0, gold: 0 };

/** Whole units of every resource. */
function cargoTotal(c: Readonly<Res>): number {
  return c.wood + c.stone + c.gold;
}

/** The kinds that carry units and need at least one. */
function needsUnits(kind: DepartureDraft["kind"]): boolean {
  return kind === "attack" || kind === "support" || kind === "found";
}

/** `TRANSPORT_CAPACITY` when land units cross water without enough carrier capacity (§6.4). */
function transportShortage(
  r: ReadCtx,
  from: DeepReadonly<City>,
  island: IslandId,
  units: Readonly<UnitCounts>,
): Rejection | null {
  if (!r.rules.movement.transportRule || from.island === island) return null;
  let pop = 0;
  let capacity = 0;
  for (const u of r.rules.units) {
    const n = units[u.id] ?? 0;
    if (u.domain === "land") pop += n * u.pop;
    capacity += n * u.capacity;
  }
  if (pop <= capacity) return null;
  return reject("TRANSPORT_CAPACITY", {
    city: from.id,
    island,
    pop,
    capacity,
    missing: pop - capacity,
  });
}

/** The units' generic checks: known ids, at least one when needed, all at home. */
function unitChecks(
  r: ReadCtx,
  from: DeepReadonly<City>,
  kind: DepartureDraft["kind"],
  units: Readonly<UnitCounts>,
): Rejection | null {
  const unknown = unknownUnit(r, units);
  if (unknown !== null) return reject("INVALID_ARGS", { unit: unknown, reason: "unknown_unit" });
  const clean = canonicalUnits(r, units);
  if (needsUnits(kind) && Object.keys(clean).length === 0) {
    return reject("NO_UNITS", { city: from.id, kind });
  }
  const short = unitShortage(r, from, clean);
  return short === null ? null : { ok: false, violation: short };
}

function verdictOf(r: ReadCtx, d: DepartureDraft): DepartureVerdict {
  const hooks = r.ruleset.hooks;
  return hooks.departure === undefined ? defaultDeparture(r, d) : hooks.departure(r, d);
}

/**
 * The time at which `load` more fits under the in-flight cap `cap` of `from`, as its shipments and
 * the returns of its bounced shipments land in arrival order (an estimate: a shipment that bounces
 * stays in flight as a return); null when the load is above the cap.
 */
function cargoRoomAt(
  r: ReadCtx,
  from: DeepReadonly<City>,
  load: number,
  cap: number,
): GameTime | null {
  if (load > cap) return null;
  const flights = sortedIds(r.state.movements)
    .map((id) => r.state.movements[id])
    .filter(
      (m): m is DeepReadonly<Movement> =>
        m !== undefined &&
        m.home === from.id &&
        m.owner === from.owner &&
        (m.kind === "shipment" || (m.kind === "return" && m.back?.kind === "shipment")),
    )
    .toSorted((a, b) => a.arriveAt - b.arriveAt);
  let inFlight = flights.reduce((n, m) => n + cargoTotal(m.cargo), 0);
  for (const m of flights) {
    inFlight -= cargoTotal(m.cargo);
    if (inFlight + load <= cap) return m.arriveAt;
  }
  return null;
}

/**
 * The verdict's rejection with the §7.3 conventions the domain guarantees: the time-gated
 * `SHIPMENT_CAPACITY` carries `availableAt` (own movements only, so fog-safe).
 */
function withDetails(r: ReadCtx, from: DeepReadonly<City>, v: Violation): Violation {
  const cap = v.details["cap"];
  const requested = v.details["requested"];
  if (
    v.code !== "SHIPMENT_CAPACITY" ||
    Object.hasOwn(v.details, "availableAt") ||
    typeof cap !== "number" ||
    typeof requested !== "number"
  ) {
    return v;
  }
  return {
    code: v.code,
    details: { ...v.details, availableAt: cargoRoomAt(r, from, requested, cap) },
  };
}

/**
 * Validates a departure: the generic checks, then `hooks.departure ?? std.defaultDeparture`, then
 * the units the verdict settled on (when it changed them) and the resources paid at departure.
 */
export function validateDeparture(
  r: ReadCtx,
  seat: PlayerId,
  input: DepartureInput,
): Verdict<LaunchPlan> {
  const own = ownCity(r, seat, input.from);
  if (!own.ok) return own;
  const from = own.city;
  let island: IslandId;
  if (input.to !== null) {
    const target = lookup(r.state.cities, input.to);
    if (target === undefined) return reject("UNKNOWN_ID", { city: input.to });
    island = target.island;
  } else {
    if (input.island === null || lookup(r.state.islands, input.island) === undefined) {
      return reject("UNKNOWN_ID", { island: input.island });
    }
    island = input.island;
  }
  if (input.slot !== null && !r.rules.toolOptions.foundSlot) {
    return reject("INVALID_ARGS", { field: "slot", ruleset: r.rules.ruleset });
  }
  const attackFrom = r.rules.time.attackFrom;
  if (input.kind === "attack" && r.now < attackFrom) {
    return reject("ATTACK_PROTECTION", { city: input.from, availableAt: attackFrom });
  }
  const units = unitChecks(r, from, input.kind, input.units);
  if (units !== null) return units;
  const clean = canonicalUnits(r, input.units);
  const transport = transportShortage(r, from, island, clean);
  if (transport !== null) return transport;
  const draft: DepartureDraft = {
    kind: input.kind,
    owner: seat,
    from: input.from,
    to: input.to,
    island,
    slot: input.slot,
    units: clean,
    cargo: { ...input.cargo },
    gold: input.gold,
  };
  const verdict = verdictOf(r, draft);
  if (!verdict.ok) return { ok: false, violation: withDetails(r, from, verdict.violation) };
  let group = clean;
  if (verdict.units !== undefined) {
    const changed = unitChecks(r, from, input.kind, verdict.units);
    if (changed !== null) return changed;
    group = canonicalUnits(r, verdict.units);
  }
  const pay = {
    wood: input.cargo.wood,
    stone: input.cargo.stone,
    gold: input.cargo.gold + input.gold,
  };
  const short = shortOf(r, input.from, pay, { kind: input.kind });
  if (short !== null) return { ok: false, violation: short };
  const plan: LaunchPlan = { draft: { ...draft, units: group }, party: verdict.party };
  const warnings = verdict.warnings ?? [];
  return warnings.length === 0 ? { ok: true, plan } : { ok: true, plan, warnings: [...warnings] };
}

/** Launches a validated departure and returns the tool-facing result. */
function launchPlan(ctx: Ctx, plan: LaunchPlan) {
  const id = launch(ctx, plan.draft, plan.party);
  const m = need(ctx.state.movements, id, "movement");
  return {
    movement: id,
    kind: plan.draft.kind,
    from: plan.draft.from,
    to: plan.draft.to,
    island: plan.draft.island,
    party: plan.party,
    depart: pair(m.departAt),
    arrive: pair(m.arriveAt),
  };
}

/** `attack {from, to, units}`. */
export const attack: ActionHandler<ActionOf<"attack">, LaunchPlan> = {
  validate: (r, seat, a) =>
    validateDeparture(r, seat, {
      kind: "attack",
      from: a.from,
      to: a.to,
      island: null,
      slot: null,
      units: a.units,
      cargo: NO_RES,
      gold: 0,
    }),
  apply: (ctx, _seat, plan) => launchPlan(ctx, plan),
};

/** `support {from, to, units}`. */
export const support: ActionHandler<ActionOf<"support">, LaunchPlan> = {
  validate: (r, seat, a) =>
    validateDeparture(r, seat, {
      kind: "support",
      from: a.from,
      to: a.to,
      island: null,
      slot: null,
      units: a.units,
      cargo: NO_RES,
      gold: 0,
    }),
  apply: (ctx, _seat, plan) => launchPlan(ctx, plan),
};

/** `spy {from, to, gold}`: no units; the gold is paid at departure. */
export const spy: ActionHandler<ActionOf<"spy">, LaunchPlan> = {
  validate: (r, seat, a) =>
    validateDeparture(r, seat, {
      kind: "spy",
      from: a.from,
      to: a.to,
      island: null,
      slot: null,
      units: {},
      cargo: NO_RES,
      gold: a.gold,
    }),
  apply: (ctx, _seat, plan) => launchPlan(ctx, plan),
};

/** `found_city {from, island, units, slot}`: `slot` only with `toolOptions.foundSlot`. */
export const foundCity: ActionHandler<ActionOf<"found_city">, LaunchPlan> = {
  validate: (r, seat, a) =>
    validateDeparture(r, seat, {
      kind: "found",
      from: a.from,
      to: null,
      island: a.island,
      slot: a.slot,
      units: a.units,
      cargo: NO_RES,
      gold: 0,
    }),
  apply: (ctx, _seat, plan) => launchPlan(ctx, plan),
};

/**
 * `send_resources {from, to, res}`: a shipment; the cargo is paid at departure and the in-flight
 * cap (`movement.shipment`, through `std.inFlightCargo`) is the default departure's.
 */
export const sendResources: ActionHandler<ActionOf<"send_resources">, LaunchPlan> = {
  validate: (r, seat, a) =>
    validateDeparture(r, seat, {
      kind: "shipment",
      from: a.from,
      to: a.to,
      island: null,
      slot: null,
      units: {},
      cargo: a.res,
      gold: 0,
    }),
  apply: (ctx, _seat, plan) => launchPlan(ctx, plan),
};
