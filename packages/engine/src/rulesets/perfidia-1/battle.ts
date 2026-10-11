import {
  compareIds,
  type CityId,
  type JsonObject,
  type MovementId,
  type PlayerId,
  type Recipient,
  type Res,
  type UnitCounts,
} from "@perfidia/protocol";
import {
  allocateLosses,
  arriveHome,
  bounce,
  citiesOf,
  cleanUnits,
  deleteMovement,
  deliverSupport,
  endPact,
  hasUnits,
  leaveAlliance,
  materialize,
  relation,
  removeUnits,
  setLevel,
  slotUnits,
  spend,
  stackGroups,
  startReturn,
  stockAt,
  type UnitSlot,
} from "@perfidia/engine/std";
import {
  type BattleKind,
  type BattleResult,
  type CombatStack,
  NEUTRAL,
  type StackOutcome,
  battleCredit,
  canBesiege,
  carryOf,
  lootOf,
  moralePm,
  resolveBattle,
  statsOf,
  wallAfterBreach,
} from "./combat.ts";
import {
  cityOf,
  draftMovementOf,
  fail,
  holdGroups,
  movementOf,
  own,
  type PCtx,
  type PRead,
} from "./common.ts";
import { battlePointsOf, relationEndedAt, siegeOf, wereRelated } from "./ext.ts";
import { announceHomecoming, breakSiege, garrisonSettlers, startSiege } from "./siege.ts";

// Attack arrivals and battles (perfidia-1 §7.5, §8, §9.3): city battles, relief battles against a
// garrison and homecoming battles of returns into a besieged home. The maths are combat.ts's; this
// module gathers the participants from the state, applies losses (split stacks allocated with
// `std.allocateLosses`), the wall breach, loot, sieges, battle points and betrayal, and emits the
// per-recipient reports and the public headline.

type Owner = PlayerId | null;

/** One stack of a battle: an owner's units of one type and the groups (slots) they sit in. */
interface StackPlan {
  readonly owner: Owner;
  readonly unit: string;
  readonly slots: readonly UnitSlot[];
  readonly sizes: readonly number[];
}

interface Fought {
  readonly kind: BattleKind;
  readonly city: CityId;
  readonly attacker: PlayerId;
  /** The defender side's label: the city owner (null: the neutral Crown) or the besieger. */
  readonly foe: Owner;
  /** Owners of defending stationed groups other than `foe`, sorted. */
  readonly stationed: readonly PlayerId[];
  readonly result: BattleResult;
  readonly attackers: readonly StackPlan[];
  readonly defenders: readonly StackPlan[];
  /** Battle points credited by this battle, after the anti-collusion rule (§8.8). */
  readonly points: readonly { player: PlayerId; points: number }[];
  /** The attacker's relation to its foe at resolution (betrayal, §8.9). */
  readonly relation: "ally" | "pact" | null;
}

/** What the battle changed besides losses, for the reports (§8.10). */
interface Outcome {
  readonly wall: { readonly before: number; readonly after: number };
  readonly loot: Res;
  readonly siege: "started" | "broken" | "holds" | null;
}

const ZERO: Res = Object.freeze({ wood: 0, stone: 0, gold: 0 });

function label(owner: Owner): string {
  return owner ?? NEUTRAL;
}

function role(ctx: PCtx, kind: "wall" | "population" | "storage"): string {
  return ctx.rules.roles[kind] ?? fail(`perfidia-1 has a ${kind} building`);
}

function levelOf(ctx: PCtx, city: CityId, building: string): number {
  return cityOf(ctx.state, city).buildings[building] ?? 0;
}

/**
 * Whether `a` and `b` earn no battle points from each other (§8.8): they are related now, were at
 * the end of the previous step, or stopped being related less than `killCreditCooldown` ago.
 */
export function creditBlocked(r: PRead, a: PlayerId, b: PlayerId): boolean {
  if (a === b || relation(r, a, b) !== "none") return true;
  const x = r.ext();
  if (wereRelated(x, a, b)) return true;
  const ended = relationEndedAt(x, a, b);
  return ended !== null && r.now < ended + r.config.time.killCreditCooldown;
}

/** The player id of a stack owner label, or null for the neutral garrison. */
function playerOf(ctx: PCtx, owner: string): PlayerId | null {
  return own(ctx.state.players, owner)?.id ?? null;
}

/** The defending slots (§8.1): the city's defenders for a city battle, the garrison otherwise. */
function defenderSlots(
  r: PRead,
  kind: BattleKind,
  city: CityId,
  attacker: PlayerId,
  foe: Owner,
): { owner: Owner; slot: UnitSlot }[] {
  if (kind !== "city") {
    if (foe === null) fail(`a ${kind} battle in ${city} needs a besieger`);
    return holdGroups(r.state, city, foe).map((g) => ({
      owner: foe,
      slot: { at: "stationed", city, owner: foe, home: g.home, role: "hold" },
    }));
  }
  const c = cityOf(r.state, city);
  const out = stackGroups(r, city, c.owner).map((slot) => ({ owner: c.owner, slot }));
  const others = [...new Set(c.stationed.map((g) => g.owner))]
    .filter((p) => p !== c.owner && p !== attacker)
    .toSorted(compareIds);
  for (const p of others) for (const slot of stackGroups(r, city, p)) out.push({ owner: p, slot });
  return out;
}

/** Stacks per owner (first-appearance order) and unit type (rules order), with their groups. */
function planStacks(r: PRead, slots: readonly { owner: Owner; slot: UnitSlot }[]): StackPlan[] {
  const owners: Owner[] = [];
  for (const s of slots) if (!owners.includes(s.owner)) owners.push(s.owner);
  const plans: StackPlan[] = [];
  for (const owner of owners) {
    const mine = slots.filter((s) => s.owner === owner).map((s) => s.slot);
    const contents = mine.map((slot) => slotUnits(r, slot));
    for (const u of r.rules.units) {
      const sizes = contents.map((c) => c[u.id] ?? 0);
      if (sizes.some((n) => n > 0)) plans.push({ owner, unit: u.id, slots: mine, sizes });
    }
  }
  return plans;
}

function total(xs: readonly number[]): number {
  let n = 0;
  for (const x of xs) n += x;
  return n;
}

/** The merged stack that combat.ts resolves; losses are allocated to the groups afterwards. */
function toCombat(p: StackPlan): CombatStack {
  return { owner: label(p.owner), unit: p.unit, groups: [total(p.sizes)] };
}

function lostOf(o: StackOutcome | undefined): number {
  return total(o?.lost ?? []);
}

/**
 * Removes each stack's losses from its groups, allocated by largest remainder (§8.3), one
 * `removeUnits` per group.
 */
function applyLosses(
  ctx: PCtx,
  plans: readonly StackPlan[],
  outcomes: readonly StackOutcome[],
): void {
  const perSlot: { slot: UnitSlot; units: UnitCounts }[] = [];
  plans.forEach((plan, i) => {
    const lost = lostOf(outcomes[i]);
    if (lost === 0) return;
    const alloc = allocateLosses(plan.sizes, lost);
    plan.slots.forEach((slot, k) => {
      const n = alloc[k] ?? 0;
      if (n === 0) return;
      let entry = perSlot.find((e) => e.slot === slot);
      if (entry === undefined) {
        entry = { slot, units: {} };
        perSlot.push(entry);
      }
      entry.units[plan.unit] = (entry.units[plan.unit] ?? 0) + n;
    });
  });
  for (const e of perSlot) removeUnits(ctx, e.slot, e.units, "killed");
}

/** Credits battle points (§8.8) without the anti-collusion pairs; returns what was credited. */
function creditPoints(
  ctx: PCtx,
  result: BattleResult,
  attacker: PlayerId,
  fallback: Owner,
): { player: PlayerId; points: number }[] {
  const r = ctx.read();
  const credit = battleCredit(statsOf(ctx.config), result, fallback);
  const gains: { player: PlayerId; points: number }[] = [];
  const gain = (player: PlayerId, points: number): void => {
    if (points <= 0) return;
    const e = gains.find((g) => g.player === player);
    if (e === undefined) gains.push({ player, points });
    else e.points += points;
  };
  for (const e of credit.attackerByOwner) {
    const victim = playerOf(ctx, e.owner);
    if (victim === null || !creditBlocked(r, attacker, victim)) gain(attacker, e.pop);
  }
  for (const e of credit.defenders) {
    const defender = playerOf(ctx, e.owner);
    if (defender !== null && !creditBlocked(r, defender, attacker)) gain(defender, e.points);
  }
  const x = ctx.ext();
  for (const g of gains) x.battlePoints[g.player] = battlePointsOf(x, g.player) + g.points;
  return gains.toSorted((a, b) => compareIds(a.player, b.player));
}

/**
 * Resolves the battle of movement `m` at `city` (§8.1–8.5): materialises the city, gathers the
 * defenders, applies morale, the naval and land phases and the losses, and credits battle points.
 * The movement keeps the attacking survivors; the caller applies the kind's outcome.
 */
function fight(ctx: PCtx, kind: BattleKind, m: MovementId, city: CityId, foe: Owner): Fought {
  materialize(ctx, city);
  const r = ctx.read();
  const mv = movementOf(ctx.state, m);
  const attacker = mv.owner;
  const c = cityOf(ctx.state, city);
  const morale = moralePm(
    ctx.config,
    citiesOf(r, attacker).length,
    foe === null ? null : citiesOf(r, foe).length,
  );
  const slots = defenderSlots(r, kind, city, attacker, foe);
  const stationed = [...new Set(slots.map((s) => s.owner))]
    .filter((p): p is PlayerId => p !== null && p !== foe && p !== attacker)
    .toSorted(compareIds);
  const attackers = planStacks(r, [{ owner: attacker, slot: { at: "movement", id: m } }]);
  const defenders = planStacks(r, slots);
  const rel = foe === null ? "none" : relation(r, attacker, foe);
  const result = resolveBattle(ctx.config, {
    kind,
    moralePm: morale,
    acrossWater: mv.fromIsland !== c.island,
    attacker: attackers.map(toCombat),
    defender: defenders.map(toCombat),
    hall: levelOf(ctx, city, role(ctx, "population")),
    wall: levelOf(ctx, city, role(ctx, "wall")),
  });
  applyLosses(ctx, attackers, result.attacker);
  applyLosses(ctx, defenders, result.defender);
  const fallback = kind === "city" ? c.owner : foe;
  const points = creditPoints(ctx, result, attacker, fallback);
  return {
    kind,
    city,
    attacker,
    foe,
    stationed,
    result,
    attackers,
    defenders,
    points,
    relation: rel === "ally" || rel === "pact" ? rel : null,
  };
}

function stackRows(
  side: "attacker" | "defender",
  plans: readonly StackPlan[],
  outcomes: readonly StackOutcome[],
): JsonObject[] {
  return plans.map((p, i) => {
    const before = total(p.sizes);
    const lost = lostOf(outcomes[i]);
    return { side, owner: label(p.owner), unit: p.unit, before, lost, survived: before - lost };
  });
}

/** The full battle report of §8.10, for one recipient. */
function fullReport(ctx: PCtx, f: Fought, o: Outcome, report: string): JsonObject {
  const res = f.result;
  const n = res.naval;
  const l = res.land;
  return {
    report,
    city: f.city,
    island: cityOf(ctx.state, f.city).island,
    kind: f.kind,
    attacker: f.attacker,
    defender: label(f.foe),
    winner: res.winner,
    moralePm: res.moralePm,
    naval: n === null ? null : { Na: n.Na, Nd: n.Nd, winner: n.winner, q: n.q },
    land:
      l === null
        ? null
        : {
            A: l.A,
            D: l.D,
            sumDefense: l.sumDefense,
            baseDefense: l.baseDefense,
            wall: o.wall.before,
            wallPm: l.wallPm,
            winner: l.winner,
            q: l.q,
          },
    stacks: [
      ...stackRows("attacker", f.attackers, res.attacker),
      ...stackRows("defender", f.defenders, res.defender),
    ],
    wall: { before: o.wall.before, after: o.wall.after },
    loot: { ...o.loot },
    siege: o.siege,
    points: f.points.map((p) => ({ player: p.player, points: p.points })),
  };
}

/** The attacker's copy when none of its units survived: outcome, phase reached, own losses. */
function redactedReport(f: Fought, report: string): JsonObject {
  const lost: Record<string, number> = {};
  f.attackers.forEach((p, i) => {
    const n = lostOf(f.result.attacker[i]);
    if (n > 0) lost[p.unit] = n;
  });
  return {
    report,
    city: f.city,
    kind: f.kind,
    attacker: f.attacker,
    defender: label(f.foe),
    winner: f.result.winner,
    phase: f.result.land !== null ? "land" : f.result.naval !== null ? "naval" : null,
    lost,
  };
}

/**
 * Emits one `battle_report` per recipient (§8.10), each with its own report id: the attacker
 * (redacted when no attacking unit survived), the foe (`party`: the city owner, or the besieger in
 * a garrison battle) and every owner of a defending stationed group (`stationed`); then the public
 * `battle` headline, without numbers. The attacker of a city or relief battle launched it: its
 * copy is `self`, an own wake. The attacker of a homecoming is the owner of the returning group,
 * which other players can send home (a dismissal, a bounce), so its copy is `target` (the battle
 * is fought at its own city), a social wake: others never spend its own budget (§14.2).
 */
function emitReports(ctx: PCtx, f: Fought, o: Outcome, attackerSurvived: boolean): void {
  const to: Recipient[] = [{ p: f.attacker, as: f.kind === "homecoming" ? "target" : "self" }];
  if (f.foe !== null && f.foe !== f.attacker) to.push({ p: f.foe, as: "party" });
  for (const p of f.stationed) to.push({ p, as: "stationed" });
  for (const rcpt of to) {
    const id = ctx.nextId("r", rcpt.p);
    const data =
      rcpt.p === f.attacker && !attackerSurvived
        ? redactedReport(f, id)
        : fullReport(ctx, f, o, id);
    ctx.emit({ type: "battle_report", public: false, to: [rcpt], data });
  }
  ctx.emit({
    type: "battle",
    public: true,
    to: [],
    data: {
      city: f.city,
      attacker: f.attacker,
      defender: label(f.foe),
      kind: f.kind,
      winner: f.result.winner,
    },
  });
}

/**
 * Betrayal on impact (§8.9): when the attacker's foe was its ally or pact partner at resolution,
 * the attacker leaves the alliance or the pact ends, and the public `betrayal` fires.
 */
function betray(ctx: PCtx, f: Fought): void {
  if (f.relation === null || f.foe === null) return;
  if (f.relation === "ally") leaveAlliance(ctx, f.attacker, "betrayal");
  else endPact(ctx, f.attacker, f.foe, "betrayal");
  ctx.emit({
    type: "betrayal",
    public: true,
    to: [
      { p: f.attacker, as: "self" },
      { p: f.foe, as: "target" },
    ],
    data: { by: f.attacker, against: f.foe, relation: f.relation, city: f.city },
  });
}

/** Takes the movement's units out of it (to put them elsewhere). */
function takeAll(ctx: PCtx, m: MovementId): UnitCounts {
  const mv = draftMovementOf(ctx, m);
  const units = cleanUnits(ctx.rules, mv.units);
  mv.units = {};
  return units;
}

/**
 * Sends the movement's survivors home from `from` with `cargo` (announced if the home is besieged)
 * and removes the movement. Survivors that already stand in their home city (a relief of the home
 * itself, re-homed there because its origin was conquered in flight, §7.7) are home at once unless
 * the home is still besieged; then they make the return trip of §7.6, from that island to itself.
 */
function sendSurvivorsHome(ctx: PCtx, m: MovementId, from: CityId, cargo: Readonly<Res>): void {
  const mv = draftMovementOf(ctx, m);
  if (mv.home === from && siegeOf(ctx.ext(), from) === null && hasUnits(mv.units)) {
    mv.cargo = { ...cargo };
    arriveHome(ctx, m);
    return;
  }
  const owner = mv.owner;
  const home = mv.home;
  const units = takeAll(ctx, m);
  if (hasUnits(units))
    announceHomecoming(ctx, startReturn(ctx, { owner, home, from, units, cargo }));
  deleteMovement(ctx, m);
}

function isZero(r: Readonly<Res>): boolean {
  return r.wood === 0 && r.stone === 0 && r.gold === 0;
}

/**
 * A city battle (§8.1, §8.6): after a won land phase the wall drops a level, then a siege starts if
 * an attacking settler survived and the city can be besieged (no capital before
 * `capitalImmunityEnd`), otherwise the survivors take loot. Survivors that do not garrison go home.
 */
function cityBattle(ctx: PCtx, m: MovementId, city: CityId): void {
  const c = cityOf(ctx.state, city);
  const isCapital = c.capitalOf !== null;
  const f = fight(ctx, "city", m, city, c.owner);
  const wallId = role(ctx, "wall");
  const before = levelOf(ctx, city, wallId);
  let after = before;
  let loot: Res = { ...ZERO };
  let besiege = false;
  const survivors = cleanUnits(ctx.rules, movementOf(ctx.state, m).units);
  if (f.result.attackerWonLand) {
    after = wallAfterBreach(ctx.config, before);
    if (after !== before) setLevel(ctx, city, wallId, after);
    const settlers = survivors[ctx.rules.roles.settler] ?? 0;
    besiege = settlers > 0 && canBesiege(ctx.config, isCapital, ctx.now);
    if (!besiege) {
      const stock = stockAt(ctx.read(), city);
      const warehouse = levelOf(ctx, city, role(ctx, "storage"));
      loot = lootOf(ctx.config, stock, warehouse, carryOf(statsOf(ctx.config), survivors));
      if (!isZero(loot)) spend(ctx, city, loot);
    }
  }
  const outcome: Outcome = {
    wall: { before, after },
    loot,
    siege: besiege ? "started" : null,
  };
  emitReports(ctx, f, outcome, hasUnits(survivors));
  if (besiege) {
    startSiege(ctx, city, f.attacker, movementOf(ctx.state, m).home, takeAll(ctx, m));
    deleteMovement(ctx, m);
  } else sendSurvivorsHome(ctx, m, city, loot);
  betray(ctx, f);
}

/**
 * A relief battle (§9.3) against the garrison: no wall breach, no loot. The siege breaks when no
 * settler is left in the garrison; the relief's survivors go home.
 */
function reliefBattle(ctx: PCtx, m: MovementId, city: CityId, besieger: PlayerId): void {
  const f = fight(ctx, "relief", m, city, besieger);
  const wall = levelOf(ctx, city, role(ctx, "wall"));
  const broken = garrisonSettlers(ctx.state, ctx.rules.roles.settler, city, besieger) === 0;
  const survived = hasUnits(movementOf(ctx.state, m).units);
  emitReports(
    ctx,
    f,
    { wall: { before: wall, after: wall }, loot: { ...ZERO }, siege: broken ? "broken" : "holds" },
    survived,
  );
  if (broken) breakSiege(ctx, city, "relief");
  sendSurvivorsHome(ctx, m, city, ZERO);
  betray(ctx, f);
}

/**
 * A homecoming battle (§9.3): a return reaching its besieged home fights the garrison, its owner
 * against the besieger. It always runs its land phase; no wall breach, no loot. Survivors of a won
 * battle are home with their cargo; a lost battle loses the whole group and its cargo. The siege
 * breaks when no settler is left in the garrison.
 */
function homecomingBattle(ctx: PCtx, m: MovementId, home: CityId, besieger: PlayerId): void {
  const f = fight(ctx, "homecoming", m, home, besieger);
  const wall = levelOf(ctx, home, role(ctx, "wall"));
  const broken = garrisonSettlers(ctx.state, ctx.rules.roles.settler, home, besieger) === 0;
  const survived = hasUnits(movementOf(ctx.state, m).units);
  emitReports(
    ctx,
    f,
    { wall: { before: wall, after: wall }, loot: { ...ZERO }, siege: broken ? "broken" : "holds" },
    survived,
  );
  if (broken) breakSiege(ctx, home, "homecoming");
  if (f.result.attackerWonLand && survived) arriveHome(ctx, m);
  else deleteMovement(ctx, m);
  betray(ctx, f);
}

/** Bounces a movement home (§7.5), announcing the return if its home is besieged. */
export function bounceHome(ctx: PCtx, m: MovementId, reason: string): void {
  bounce(ctx, m, reason);
  announceHomecoming(ctx, m);
}

/**
 * `arrive.attack` (§7.5): joins the garrison of a city the mover besieges, fights a relief battle
 * when its recorded foe is the besieger, a city battle when the city is not besieged and still
 * owned by its foe, and bounces otherwise: an attack only ever fights the foe recorded at launch.
 * A relief re-homed onto its own target (its origin was conquered in flight, §7.7) that finds the
 * siege over is home on arrival.
 */
export function arriveAttack(ctx: PCtx, m: MovementId): void {
  const mv = movementOf(ctx.state, m);
  const city = mv.to ?? fail(`attack ${m} has no target city`);
  const siege = siegeOf(ctx.ext(), city);
  if (siege !== null) {
    if (siege.by === mv.owner) deliverSupport(ctx, m, "hold");
    else if (siege.by === mv.party) reliefBattle(ctx, m, city, siege.by);
    else bounceHome(ctx, m, "target_besieged");
    return;
  }
  if (mv.home === city) arriveHome(ctx, m);
  else if (cityOf(ctx.state, city).owner === mv.party) cityBattle(ctx, m, city);
  else bounceHome(ctx, m, "target_changed");
}

/**
 * `arrive.return` (§7.5): units come home with their cargo, or fight a homecoming battle when
 * another player besieges their home.
 */
export function arriveReturn(ctx: PCtx, m: MovementId): void {
  const mv = movementOf(ctx.state, m);
  const siege = siegeOf(ctx.ext(), mv.home);
  if (siege !== null && siege.by !== mv.owner) homecomingBattle(ctx, m, mv.home, siege.by);
  else arriveHome(ctx, m);
}
