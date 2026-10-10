// Movement primitives (docs/architecture.md §5.4, §8.6). A movement's arrival is the scheduled
// event `arrive_<kind>` with the movement id as ref; `movement.seq` is that event's seq. An arrival
// handler runs after the kernel popped its event, so it never cancels it.

import {
  compareIds,
  type CityId,
  type GameTime,
  type IslandId,
  type Movement,
  type MovementId,
  type MovementKind,
  type PlayerId,
  type Recipient,
  type Res,
  type Stationed,
  type UnitCounts,
} from "@perfidia/protocol";
import type { Ctx, DepartureDraft } from "@perfidia/engine/contracts";
import { incomingAudience, recipients } from "./audience.ts";
import { isHeldAgainst, travel } from "./derive.ts";
import { addCapped, spend } from "./stock.ts";
import { putHome, takeHome } from "./units.ts";
import {
  addInto,
  assertRes,
  cancelIfQueued,
  cleanUnits,
  covers,
  draftCity,
  draftMovement,
  emitTo,
  fail,
  hasUnits,
  isZeroRes,
  readCity,
  takeFrom,
  zeroRes,
} from "./util.ts";

/** A new return trip home (§7.6 of perfidia-1): survivors, recalled or dismissed stationed units. */
export interface ReturnSpec {
  readonly owner: PlayerId;
  /** Where the units belong, the destination. */
  readonly home: CityId;
  /** The city the group leaves. */
  readonly from: CityId;
  /** Default: the island of `from`. */
  readonly fromIsland?: IslandId;
  readonly units: Readonly<UnitCounts>;
  readonly cargo?: Readonly<Res>;
  /** Default `null` (a return carries no recorded party unless the ruleset gives one). */
  readonly party?: PlayerId | null;
  /** Set for a return made by a recall or a bounce; default `null`. */
  readonly back?: { readonly kind: MovementKind; readonly at: GameTime } | null;
}

function arrivalKind(kind: MovementKind): string {
  return `arrive_${kind}`;
}

function self(p: PlayerId): Recipient[] {
  return [{ p, as: "self" }];
}

/**
 * The city owner's full copy of an arrival (§8.6): addressed as `party` when the owner is the
 * movement's recorded party, as `launch` addressed it in the incoming notice, else as `target`
 * (a reinforcement joining a `hold` group, whose recorded party is not the owner).
 */
function ownerCopy(mv: Readonly<Movement>, owner: PlayerId): Recipient[] {
  return [{ p: owner, as: owner === mv.party ? "party" : "target" }];
}

/**
 * Launches a validated departure: takes the units from home, pays the cargo and the spy gold,
 * creates the movement (party recorded), schedules its arrival after `travel` and emits the
 * incoming notice to its audience (`incoming_attack`, `incoming_support`, `incoming_shipment`;
 * nothing for spies and founders). Returns the new movement id.
 */
export function launch(ctx: Ctx, d: DepartureDraft, party: PlayerId | null): MovementId {
  const from = readCity(ctx.state, d.from);
  if (from.owner !== d.owner) fail(`${d.owner} launches from ${d.from}, which it does not own`);
  const units = cleanUnits(ctx.rules, d.units, `units launched from ${d.from}`);
  assertRes(d.cargo, `cargo launched from ${d.from}`);
  if (!Number.isSafeInteger(d.gold) || d.gold < 0) fail(`gold must be ≥ 0, got ${d.gold}`);
  takeHome(ctx, d.from, units);
  const pay = { wood: d.cargo.wood, stone: d.cargo.stone, gold: d.cargo.gold + d.gold };
  if (!isZeroRes(pay)) spend(ctx, d.from, pay);
  const id = ctx.nextId("m", d.owner);
  const arriveAt = ctx.now + travel(ctx.read(), from.island, d.island, { kind: d.kind, units });
  const seq = ctx.schedule(arrivalKind(d.kind), arriveAt, id);
  ctx.state.movements[id] = {
    id,
    kind: d.kind,
    owner: d.owner,
    home: d.from,
    from: d.from,
    fromIsland: from.island,
    to: d.to,
    toIsland: d.island,
    slot: d.slot,
    party,
    units,
    cargo: { ...d.cargo },
    gold: d.gold,
    departAt: ctx.now,
    arriveAt,
    seq,
    back: null,
  };
  const to = d.to;
  if (to === null || d.kind === "spy" || d.kind === "found") return id;
  const audience = incomingAudience(ctx.read(), id);
  const base = { movement: id, from: d.from, by: d.owner, to, departAt: ctx.now, arriveAt };
  if (d.kind === "attack") {
    emitTo(ctx, "incoming_attack", { ...base, foe: party, homecoming: false }, audience);
  } else if (d.kind === "support") {
    emitTo(ctx, "incoming_support", { ...base, units: { ...units } }, audience);
  } else {
    emitTo(ctx, "incoming_shipment", { ...base, cargo: { ...d.cargo } }, audience);
  }
  return id;
}

/** Turns movement `m` into a return home leaving `fromIsland` now, arriving after `duration`. */
function toReturn(
  ctx: Ctx,
  m: Movement,
  from: CityId,
  fromIsland: IslandId,
  duration: number,
): void {
  const home = readCity(ctx.state, m.home);
  cancelIfQueued(ctx, m.seq);
  m.back = { kind: m.kind, at: ctx.now };
  m.kind = "return";
  m.from = from;
  m.fromIsland = fromIsland;
  m.to = m.home;
  m.toIsland = home.island;
  m.slot = null;
  m.departAt = ctx.now;
  m.arriveAt = ctx.now + duration;
  m.seq = ctx.schedule(arrivalKind("return"), m.arriveAt, m.id);
}

/**
 * Recall within the window (validated by the caller): the movement turns back and arrives home at
 * `now + max(1, now − departAt)`, or `now + max(minTravel, now − departAt)` when its home is held by
 * another player's `hold` group (a homecoming battle obeys the speed rule, §5.4). Emits
 * `movement_recalled` to the mover and to everyone who was told about it.
 */
export function turnBack(ctx: Ctx, m: MovementId): void {
  const mv = draftMovement(ctx, m);
  if (mv.kind === "return") fail(`${m} is already a return`);
  const audience = incomingAudience(ctx.read(), m);
  const elapsed = ctx.now - mv.departAt;
  const floor = isHeldAgainst(ctx.read(), mv.home, mv.owner) ? ctx.rules.time.minTravel : 1;
  const original = { kind: mv.kind, to: mv.to };
  toReturn(ctx, mv, mv.from, mv.fromIsland, Math.max(floor, elapsed));
  emitTo(
    ctx,
    "movement_recalled",
    { movement: m, kind: original.kind, by: mv.owner, to: original.to, arriveAt: mv.arriveAt },
    recipients([[mv.owner, "self"], ...audience.map((x) => [x.p, x.as] as const)]),
  );
}

/**
 * A movement that cannot resolve at its target turns into a return at once (§7.5 of perfidia-1):
 * it travels from the target island home with its units and cargo. Emits `bounced` (movement,
 * original kind, public reason) to the mover.
 */
export function bounce(ctx: Ctx, m: MovementId, reason = "target_unavailable"): void {
  const mv = draftMovement(ctx, m);
  if (mv.kind === "return") fail(`${m} is already a return`);
  const kind = mv.kind;
  const home = readCity(ctx.state, mv.home);
  const duration = travel(ctx.read(), mv.toIsland, home.island, {
    kind: "return",
    units: { ...mv.units },
  });
  toReturn(ctx, mv, mv.to ?? mv.from, mv.toIsland, duration);
  emitTo(ctx, "bounced", { movement: m, kind, reason }, self(mv.owner));
}

/**
 * Creates a new return trip (new movement id) from `spec.from` to `spec.home`, timed by `travel`
 * for a `return` group. The caller has already taken the units and cargo from where they were.
 * Emits nothing: returns are own movements (a ruleset tells a holder of the home, §8.6).
 */
export function startReturn(ctx: Ctx, spec: ReturnSpec): MovementId {
  const home = readCity(ctx.state, spec.home);
  const fromIsland = spec.fromIsland ?? readCity(ctx.state, spec.from).island;
  const units = cleanUnits(ctx.rules, spec.units, `units returning to ${spec.home}`);
  const cargo = spec.cargo === undefined ? zeroRes() : { ...spec.cargo };
  assertRes(cargo, `cargo returning to ${spec.home}`);
  const id = ctx.nextId("m", spec.owner);
  const arriveAt = ctx.now + travel(ctx.read(), fromIsland, home.island, { kind: "return", units });
  const seq = ctx.schedule(arrivalKind("return"), arriveAt, id);
  ctx.state.movements[id] = {
    id,
    kind: "return",
    owner: spec.owner,
    home: spec.home,
    from: spec.from,
    fromIsland,
    to: spec.home,
    toIsland: home.island,
    slot: null,
    party: spec.party ?? null,
    units,
    cargo,
    gold: 0,
    departAt: ctx.now,
    arriveAt,
    seq,
    back: spec.back === undefined || spec.back === null ? null : { ...spec.back },
  };
  return id;
}

/** Removes a movement record and its arrival event if still queued. Its units must be gone already. */
export function deleteMovement(ctx: Ctx, m: MovementId): void {
  const mv = draftMovement(ctx, m);
  cancelIfQueued(ctx, mv.seq);
  delete ctx.state.movements[m];
}

/**
 * Delivers a shipment at its target (the caller checked the target accepts it): the cargo is added
 * capped by the warehouse, the recipient (the city's owner, as `party` when it is the recorded
 * party) gets `shipment_delivered` with the amounts and the overflow lost, the sender gets
 * `{movement, to, outcome}` only (§8.6), and the movement is removed.
 */
export function deliverShipment(ctx: Ctx, m: MovementId): void {
  const mv = draftMovement(ctx, m);
  if (mv.kind !== "shipment" || mv.to === null) fail(`${m} is not a shipment`);
  const to = mv.to;
  const owner = readCity(ctx.state, to).owner;
  const cargo = { ...mv.cargo };
  const lost = addCapped(ctx, to, cargo);
  const full = {
    movement: m,
    to,
    outcome: "delivered",
    by: mv.owner,
    from: mv.from,
    res: cargo,
    lost,
  };
  if (owner === mv.owner) {
    emitTo(ctx, "shipment_delivered", full, self(mv.owner));
  } else {
    if (owner !== null) emitTo(ctx, "shipment_delivered", full, ownerCopy(mv, owner));
    emitTo(ctx, "shipment_delivered", { movement: m, to, outcome: "delivered" }, self(mv.owner));
  }
  deleteMovement(ctx, m);
}

/**
 * Stations an arriving group in its target city (the caller checked the target accepts it): its
 * units join the group of (mover, home, `role`) there, the city's owner gets `support_arrived`
 * with the units (as `party` when it is the recorded party, else as `target`), the sender gets
 * `{movement, by, to}` only (§8.6: its group is stationed), and the movement is removed.
 * `role: "hold"` is for a ruleset whose reinforcements join a garrison.
 */
export function deliverSupport(
  ctx: Ctx,
  m: MovementId,
  role: "support" | "hold" = "support",
): void {
  const mv = draftMovement(ctx, m);
  if (mv.to === null) fail(`${m} has no target city`);
  const to = mv.to;
  const owner = readCity(ctx.state, to).owner;
  const units = cleanUnits(ctx.rules, mv.units);
  station(ctx, to, { owner: mv.owner, home: mv.home, role, units });
  mv.units = {};
  const full = { movement: m, by: mv.owner, to, units };
  if (owner === mv.owner) {
    emitTo(ctx, "support_arrived", full, self(mv.owner));
  } else {
    if (owner !== null) emitTo(ctx, "support_arrived", full, ownerCopy(mv, owner));
    emitTo(ctx, "support_arrived", { movement: m, by: mv.owner, to }, self(mv.owner));
  }
  deleteMovement(ctx, m);
}

/**
 * A return home: units at home, cargo added capped, `returned` (with `lost` when the cap bit) to
 * the owner, movement removed. The caller checked that the home is the mover's and can be entered.
 */
export function arriveHome(ctx: Ctx, m: MovementId): void {
  const mv = draftMovement(ctx, m);
  const home = readCity(ctx.state, mv.home);
  if (home.owner !== mv.owner) fail(`${m} returns to ${mv.home}, which ${mv.owner} does not own`);
  const units = cleanUnits(ctx.rules, mv.units);
  const cargo = { ...mv.cargo };
  putHome(ctx, mv.home, units);
  const lost = addCapped(ctx, mv.home, cargo);
  const data = { movement: m, city: mv.home, units, cargo };
  emitTo(ctx, "returned", isZeroRes(lost) ? data : { ...data, lost }, self(mv.owner));
  deleteMovement(ctx, m);
}

function compareGroups(a: Readonly<Stationed>, b: Readonly<Stationed>): number {
  return (
    compareIds(a.owner, b.owner) ||
    compareIds(a.home, b.home) ||
    (a.role === b.role ? 0 : a.role < b.role ? -1 : 1)
  );
}

/**
 * Adds a group to the city's stationed groups, merging with the group of the same
 * (owner, home, role) and keeping the list sorted. The caller took the units from where they were.
 */
export function station(ctx: Ctx, city: CityId, g: Readonly<Stationed>): void {
  const c = draftCity(ctx, city);
  if (g.home === city) fail(`units homed in ${city} cannot be stationed there`);
  readCity(ctx.state, g.home);
  const units = cleanUnits(ctx.rules, g.units, `units stationed in ${city}`);
  if (!hasUnits(units)) fail(`an empty group cannot be stationed in ${city}`);
  const same = c.stationed.find((x) => compareGroups(x, g) === 0);
  if (same !== undefined) {
    addInto(ctx.rules, same.units, units);
    return;
  }
  c.stationed.push({ owner: g.owner, home: g.home, role: g.role, units });
  c.stationed.sort(compareGroups);
}

/** `support` groups before `hold` groups, so a partial unstation never strips a garrison first. */
function supportFirst(a: Readonly<Stationed>, b: Readonly<Stationed>): number {
  return a.role === b.role ? 0 : a.role === "support" ? -1 : 1;
}

/**
 * Takes units of `owner` homed in `home` out of the city's stationed groups and returns them: all
 * of them when `units` is omitted, otherwise exactly `units`. With `role`, only the group of that
 * role is used (a dismissal passes `"support"`, a garrison recall `"hold"`); without it, the
 * `support` group is used before the `hold` group (a player has one group per home and role).
 * Empty groups are removed. Throws when no group matches or on a shortfall.
 */
export function unstation(
  ctx: Ctx,
  city: CityId,
  owner: PlayerId,
  home: CityId,
  units?: Readonly<UnitCounts>,
  role?: Stationed["role"],
): UnitCounts {
  const c = draftCity(ctx, city);
  const groups = c.stationed
    .filter((g) => g.owner === owner && g.home === home && (role === undefined || g.role === role))
    .toSorted(supportFirst);
  const which = role === undefined ? "group" : `${role} group`;
  if (groups.length === 0) fail(`no ${which} of ${owner} from ${home} in ${city}`);
  const available: UnitCounts = {};
  for (const g of groups) addInto(ctx.rules, available, g.units);
  const want = cleanUnits(ctx.rules, units ?? available, `units unstationed from ${city}`);
  if (!covers(available, want)) {
    fail(
      `${owner} has ${JSON.stringify(available)} in its ${which} from ${home} in ${city}, not ${JSON.stringify(want)}`,
    );
  }
  const remaining: UnitCounts = { ...want };
  for (const g of groups) {
    const part: UnitCounts = {};
    for (const u of ctx.rules.units) {
      const k = Math.min(remaining[u.id] ?? 0, g.units[u.id] ?? 0);
      if (k === 0) continue;
      part[u.id] = k;
      remaining[u.id] = (remaining[u.id] ?? 0) - k;
    }
    takeFrom(ctx.rules, g.units, part, `units of ${owner} in ${city}`);
  }
  c.stationed = c.stationed.filter((g) => hasUnits(g.units));
  return want;
}
