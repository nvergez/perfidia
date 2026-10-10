// Departures (docs/architecture.md §7.1, §3.4; perfidia-1 §6.4, §7.3, generic parts): `attack`,
// `support`, `spy`, `found_city` and `send_resources`. The generic checks run first (own origin,
// target ids, the `slot` tool option, `attackFrom`, units at home, the transport rule); then the
// ruleset's `hooks.departure`, or `std.defaultDeparture`, decides the kind-specific rules and the
// recorded party, with its warnings; then the domain re-checks the group the verdict settled on,
// takes the cargo and the spy gold from the stock, and enforces the data-driven shipment rules
// (`movement.shipment`) whatever the hook decided. `apply` launches through `std.launch`, which
// schedules the arrival and emits the incoming notices.

import type { Ctx, DepartureDraft, DepartureVerdict, ReadCtx } from "@perfidia/engine/contracts";
import { defaultDeparture, inFlightCargo, launch, sortedIds, travel } from "@perfidia/engine/std";
import type {
  ActionOf,
  City,
  CityId,
  CompiledRules,
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
  NO_RES,
  canonicalUnits,
  handler,
  level,
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

/** A departure as `validateDeparture` takes it: one shape for the five departure actions. */
export interface DepartureInput {
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

type ShipmentRule = NonNullable<CompiledRules["movement"]["shipment"]>;

/** Whole units of every resource. */
function cargoTotal(c: Readonly<Res>): number {
  return c.wood + c.stone + c.gold;
}

/** What leaves the city's stock at departure: the cargo plus the spy's gold. */
function paidOf(cargo: Readonly<Res>, gold: number): Res {
  return { wood: cargo.wood, stone: cargo.stone, gold: cargo.gold + gold };
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
  // `need`: the land pop to carry; `capacity`: what the group's carriers hold.
  return reject("TRANSPORT_CAPACITY", {
    city: from.id,
    island,
    need: pop,
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

// The in-flight shipment cap ---------------------------------------------------------------------

function capAt(rule: ShipmentRule, buildingLevel: number): number {
  return rule.base + rule.perLevel * buildingLevel;
}

/** Whether `m` is cargo in flight from `from`, as `std.inFlightCargo` counts it. */
function cargoOf(from: DeepReadonly<City>, m: DeepReadonly<Movement>): boolean {
  if (m.home !== from.id || m.owner !== from.owner) return false;
  return m.kind === "shipment" || (m.kind === "return" && m.back?.kind === "shipment");
}

/**
 * When the cargo of an own in-flight movement stops counting: at its arrival, except for a shipment
 * that the default arrival will bounce (its target is no longer owned by the party recorded at
 * launch), whose cargo counts until its return lands, one return trip later. Owners are public and
 * the movement is the seat's own, so this stays fog-safe.
 */
function cargoFreedAt(r: ReadCtx, from: DeepReadonly<City>, m: DeepReadonly<Movement>): GameTime {
  if (m.kind !== "shipment") return m.arriveAt;
  const owner = m.to === null ? null : (lookup(r.state.cities, m.to)?.owner ?? null);
  if (owner !== null && owner === m.party) return m.arriveAt;
  return m.arriveAt + travel(r, m.toIsland, from.island, { kind: "return", units: { ...m.units } });
}

/**
 * The earliest time at which `load` more fits under the in-flight cap of `from`, as its cargo in
 * flight stops counting (`cargoFreedAt`) and its queued levels of the shipment building complete;
 * null when neither ever makes room. An estimate on the default arrivals (a ruleset's own arrival
 * may keep cargo in flight longer). Every change at one second applies before the cap is compared,
 * so the order of same-second changes cannot reach the result.
 */
function cargoRoomAt(
  r: ReadCtx,
  from: DeepReadonly<City>,
  rule: ShipmentRule,
  load: number,
): GameTime | null {
  const flights = sortedIds(r.state.movements)
    .map((id) => r.state.movements[id])
    .filter((m): m is DeepReadonly<Movement> => m !== undefined && cargoOf(from, m))
    .map((m) => ({ at: cargoFreedAt(r, from, m), cargo: cargoTotal(m.cargo) }));
  const levels = from.build.filter((x) => x.building === rule.building).map((x) => x.end);
  const times = [...flights.map((f) => f.at), ...levels]
    .toSorted((a, b) => a - b)
    .filter((t, i, all) => i === 0 || all[i - 1] !== t);
  let inFlight = flights.reduce((n, f) => n + f.cargo, 0);
  let built = level(from, rule.building);
  for (const t of times) {
    for (const f of flights) if (f.at === t) inFlight -= f.cargo;
    for (const end of levels) if (end === t) built += 1;
    if (inFlight + load <= capAt(rule, built)) return t;
  }
  return null;
}

/**
 * The shipment rules the domain enforces whatever the departure hook decided (§3.1: data-driven
 * rules are the domain's): a load of at least 1 and, under `movement.shipment`, the cargo in flight
 * from the origin (`std.inFlightCargo`) plus this load within `base + perLevel · level`, else
 * `SHIPMENT_CAPACITY` with `availableAt` (`cargoRoomAt`).
 */
function shipmentLimit(
  r: ReadCtx,
  from: DeepReadonly<City>,
  cargo: Readonly<Res>,
): Rejection | null {
  const load = cargoTotal(cargo);
  if (load < 1) return reject("INVALID_ARGS", { load });
  const rule = r.rules.movement.shipment;
  if (rule === null) return null;
  const cap = capAt(rule, level(from, rule.building));
  const inFlight = inFlightCargo(r, from.id);
  if (inFlight + load <= cap) return null;
  return reject("SHIPMENT_CAPACITY", {
    city: from.id,
    cap,
    inFlight,
    requested: load,
    availableAt: cargoRoomAt(r, from, rule, load),
  });
}

/**
 * The verdict's rejection with the §7.3 conventions the domain guarantees: a `SHIPMENT_CAPACITY`
 * of the hook (the default departure's) gets the `availableAt` of `cargoRoomAt`.
 */
function withDetails(r: ReadCtx, from: DeepReadonly<City>, v: Violation): Violation {
  const rule = r.rules.movement.shipment;
  const requested = v.details["requested"];
  if (
    v.code !== "SHIPMENT_CAPACITY" ||
    rule === null ||
    Object.hasOwn(v.details, "availableAt") ||
    typeof requested !== "number"
  ) {
    return v;
  }
  return {
    code: v.code,
    details: { ...v.details, availableAt: cargoRoomAt(r, from, rule, requested) },
  };
}

// Validation and launch --------------------------------------------------------------------------

/**
 * Validates a departure: the generic checks, then `hooks.departure ?? std.defaultDeparture`, then
 * the group the verdict settled on (units at home and the transport rule, when it changed them),
 * the resources paid at departure and, for a shipment, the domain's shipment rules. A ruleset that
 * replaces an action handler can reuse it.
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
    return reject("INVALID_ARGS", {
      field: "slot",
      ruleset: r.rules.ruleset,
      reason: "unsupported",
    });
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
    const carried = transportShortage(r, from, island, group);
    if (carried !== null) return carried;
  }
  const short = shortOf(r, input.from, paidOf(input.cargo, input.gold), { kind: input.kind });
  if (short !== null) return { ok: false, violation: short };
  if (input.kind === "shipment") {
    const limit = shipmentLimit(r, from, input.cargo);
    if (limit !== null) return limit;
  }
  const plan: LaunchPlan = { draft: { ...draft, units: group }, party: verdict.party };
  const warnings = verdict.warnings ?? [];
  return warnings.length === 0 ? { ok: true, plan } : { ok: true, plan, warnings: [...warnings] };
}

/**
 * Launches a validated departure and returns the tool-facing result (§7.4): the movement, its
 * group (`units`), what the stock paid (`paid`: the cargo plus the spy's gold) and the times.
 */
function launchPlan(ctx: Ctx, plan: LaunchPlan) {
  const d = plan.draft;
  const id = launch(ctx, d, plan.party);
  const m = need(ctx.state.movements, id, "movement");
  return {
    movement: id,
    kind: d.kind,
    from: d.from,
    to: d.to,
    island: d.island,
    party: plan.party,
    units: { ...d.units },
    paid: paidOf(d.cargo, d.gold),
    depart: pair(m.departAt),
    arrive: pair(m.arriveAt),
  };
}

/** `attack {from, to, units}`. */
export const attack = handler<ActionOf<"attack">, LaunchPlan>({
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
});

/** `support {from, to, units}`. */
export const support = handler<ActionOf<"support">, LaunchPlan>({
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
});

/** `spy {from, to, gold}`: no units; the gold is paid at departure. */
export const spy = handler<ActionOf<"spy">, LaunchPlan>({
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
});

/** `found_city {from, island, units, slot}`: `slot` only with `toolOptions.foundSlot`. */
export const foundCity = handler<ActionOf<"found_city">, LaunchPlan>({
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
});

/**
 * `send_resources {from, to, res}`: a shipment; the cargo is paid at departure. The load of at
 * least 1 and the in-flight cap (`movement.shipment`, through `std.inFlightCargo`) are enforced by
 * the domain after the departure hook, so a hook that does not delegate to the default keeps them.
 */
export const sendResources = handler<ActionOf<"send_resources">, LaunchPlan>({
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
});
