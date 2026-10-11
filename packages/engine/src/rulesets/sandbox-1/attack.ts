import { own } from "@perfidia/engine/core";
import type { Ctx } from "@perfidia/engine/contracts";
import {
  bounce,
  citiesOf,
  deleteMovement,
  disbandHomed,
  eliminate,
  hasUnits,
  putHome,
  recipients,
  removeUnits,
  slotUnits,
  spend,
  stackGroups,
  startReturn,
  stockAt,
  transferCity,
  type UnitSlot,
} from "@perfidia/engine/std";
import {
  compareIds,
  type City,
  type CityId,
  type DeepReadonly,
  type JsonObject,
  type Movement,
  type MovementId,
  type PlayerId,
  type Res,
  type Role,
  type UnitCounts,
} from "@perfidia/protocol";
import { carryOf, lootTake, resolveBattle, survivorsOf, type BattleResult } from "./combat.ts";
import type { SandboxConfig } from "./config.ts";
import type { SandboxExt } from "./ext.ts";

// `hooks.arrive.attack` (docs/architecture.md §3.8): a land battle at the target city, then an
// immediate capture, a raid, or a repelled attack.
//
// - An attack only fights the owner recorded at launch (its `party`, std's default departure). If
//   the city changed owner since, the attack bounces home (`owner_changed`), as in perfidia-1: the
//   new owner was never warned of it, and an attack can never hit the city its own owner took.
// - Units of the attacker stationed in the target stand aside: they neither fight nor die.
// - Capture: the attacker wins, a colonist survives and the target is not a capital, or the attack
//   lands at or after `time.capitalImmunityEnd`. One colonist settles (`consumed`); everything homed
//   in the city is disbanded wherever it is; the city changes owner with its queues cleared
//   without refund; the survivors and the boats become its home units. The former owner is
//   eliminated when it has no city left.
// - Raid: the attacker wins otherwise; the survivors take loot (`lootTake`) and sail home with it.
// - Repelled: every attacking land unit died; the boats sail home empty.
//
// Every battle emits the public headline `battle` and one `battle_report` per participant (the
// attacker, the city owner, every owner of a defending stationed group), each with its own report
// id. A capture emits the public `city_conquered`; an elimination, std's `player_eliminated`.

type SandboxCtx = Ctx<SandboxConfig, SandboxExt>;

/** The battle type label of every sandbox-1 battle (there are no sieges). */
export const BATTLE_KIND = "city";

/** The keep: its completed level adds `combat.keepDefense` per level to D. */
const KEEP = "keep";
/** The colonist: one settles a captured city. */
const COLONIST = "colonist";

function bug(message: string): never {
  throw new Error(`sandbox-1: ${message}`);
}

/** One defending group with where it sits. */
interface Group {
  readonly owner: PlayerId | null;
  readonly slot: UnitSlot;
  readonly units: UnitCounts;
}

/**
 * The defender side, in allocation order: the city's owner, then the other owners of stationed
 * groups by player (never the attacker, whose units stand aside), each with its non-empty groups
 * in `std.stackGroups` order (units at home first, then stationed groups by home city and role).
 */
function defenderGroups(ctx: SandboxCtx, city: DeepReadonly<City>, attacker: PlayerId): Group[] {
  const r = ctx.read();
  const owners: (PlayerId | null)[] = [];
  if (city.owner !== attacker) owners.push(city.owner);
  const stationed = city.stationed
    .map((g) => g.owner)
    .filter((p) => p !== attacker && p !== city.owner)
    .toSorted(compareIds);
  for (const p of stationed) if (!owners.includes(p)) owners.push(p);
  const out: Group[] = [];
  for (const owner of owners) {
    for (const slot of stackGroups(r, city.id, owner)) {
      const units = slotUnits(r, slot);
      if (hasUnits(units)) out.push({ owner, slot, units });
    }
  }
  return out;
}

/** `Σ` of the groups of each owner, in owner order of first appearance. */
function byOwner(
  groups: readonly Group[],
  lost: readonly UnitCounts[],
): { player: PlayerId | "neutral"; before: UnitCounts; lost: UnitCounts }[] {
  const out: { player: PlayerId | "neutral"; before: UnitCounts; lost: UnitCounts }[] = [];
  for (const [i, g] of groups.entries()) {
    const player = g.owner ?? "neutral";
    let row = out.find((x) => x.player === player);
    if (row === undefined) {
      row = { player, before: {}, lost: {} };
      out.push(row);
    }
    for (const [unit, n] of Object.entries(g.units)) {
      if (n !== undefined) row.before[unit] = (row.before[unit] ?? 0) + n;
    }
    for (const [unit, n] of Object.entries(lost[i] ?? {})) {
      if (n !== undefined && n > 0) row.lost[unit] = (row.lost[unit] ?? 0) + n;
    }
  }
  return out;
}

type Outcome = "captured" | "raided" | "repelled";

/** The report's data, common to every recipient's copy (each adds its own report id). */
function reportData(
  m: DeepReadonly<Movement>,
  city: DeepReadonly<City>,
  groups: readonly Group[],
  battle: BattleResult,
  outcome: Outcome,
  loot: Res,
  capitalImmune: boolean,
): JsonObject {
  return {
    city: city.id,
    island: city.island,
    attacker: m.owner,
    defender: city.owner ?? "neutral",
    kind: BATTLE_KIND,
    winner: battle.winner,
    outcome,
    attack: battle.attack,
    defense: battle.defense,
    keep: city.buildings[KEEP] ?? 0,
    lossPm: battle.lossPm,
    attackerUnits: { before: { ...m.units }, lost: { ...battle.attackerLost } },
    defenders: byOwner(groups, battle.defenderLost),
    loot: { ...loot },
    capitalImmune,
  };
}

/** Takes every unit out of the movement (no ledger change: they keep existing) and deletes it. */
function emptyAndDelete(ctx: SandboxCtx, m: Movement): UnitCounts {
  const units = { ...m.units };
  m.units = {};
  deleteMovement(ctx, m.id);
  return units;
}

/** `hooks.arrive.attack`. */
export function arriveAttack(ctx: SandboxCtx, id: MovementId): void {
  const m = own(ctx.state.movements, id) ?? bug(`attack ${id} does not exist`);
  if (m.to === null) bug(`attack ${id} has no target city`);
  const cityId: CityId = m.to;
  const city = own(ctx.state.cities, cityId) ?? bug(`attack ${id} targets the missing ${cityId}`);
  const attacker = m.owner;
  if (city.owner !== m.party || city.owner === attacker) {
    bounce(ctx, id, "owner_changed");
    return;
  }
  const defender = city.owner;
  const config = ctx.config;
  const rules = ctx.rules;

  const groups = defenderGroups(ctx, city, attacker);
  const battle = resolveBattle(rules.units, {
    attacker: m.units,
    defenders: groups,
    keep: city.buildings[KEEP] ?? 0,
    keepDefense: config.combat.keepDefense,
  });
  const before: DeepReadonly<Movement> = { ...m, units: { ...m.units } };
  for (const [i, g] of groups.entries()) {
    const lost = battle.defenderLost[i] ?? {};
    if (hasUnits(lost)) removeUnits(ctx, g.slot, lost, "killed");
  }
  if (hasUnits(battle.attackerLost)) {
    removeUnits(ctx, { at: "movement", id }, battle.attackerLost, "killed");
  }

  const won = battle.winner === "attacker";
  const survivors = survivorsOf(rules.units, before.units, battle.attackerLost);
  const colonist = (survivors[COLONIST] ?? 0) > 0;
  const immune = city.capitalOf !== null && ctx.now < config.time.capitalImmunityEnd;
  const capture = won && colonist && !immune;
  let loot: Res = { wood: 0, stone: 0, gold: 0 };
  if (won && !capture) {
    loot = lootTake(
      stockAt(ctx.read(), cityId),
      carryOf(rules.units, survivors),
      config.combat.lootPm,
    );
    if (loot.wood + loot.stone + loot.gold > 0) spend(ctx, cityId, loot);
  }
  const outcome: Outcome = capture ? "captured" : won ? "raided" : "repelled";

  const headline = {
    city: cityId,
    attacker,
    defender: defender ?? "neutral",
    kind: BATTLE_KIND,
    winner: battle.winner,
  };
  ctx.emit({ type: "battle", public: true, to: [], data: headline });
  const data = reportData(before, city, groups, battle, outcome, loot, won && colonist && immune);
  const entries: [PlayerId | null, Role][] = [
    [attacker, "self"],
    [defender, "target"],
    ...groups.map((g): [PlayerId | null, Role] => [g.owner, "stationed"]),
  ];
  for (const rec of recipients(entries)) {
    ctx.emit({
      type: "battle_report",
      public: false,
      to: [rec],
      data: { report: ctx.nextId("r", rec.p), ...data },
    });
  }

  if (!capture) {
    const home = m.home;
    const units = emptyAndDelete(ctx, m);
    if (hasUnits(units))
      startReturn(ctx, { owner: attacker, home, from: cityId, units, cargo: loot });
    return;
  }

  removeUnits(ctx, { at: "movement", id }, { [COLONIST]: 1 }, "consumed");
  const units = emptyAndDelete(ctx, m);
  disbandHomed(ctx, cityId);
  transferCity(ctx, cityId, attacker);
  if (hasUnits(units)) putHome(ctx, cityId, units);
  ctx.emit({
    type: "city_conquered",
    public: true,
    to: recipients([
      [attacker, "self"],
      [defender, "target"],
    ]),
    data: { city: cityId, from: defender, to: attacker },
  });
  if (defender !== null && citiesOf(ctx.read(), defender).length === 0) eliminate(ctx, defender);
}
