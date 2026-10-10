// The std invariants of docs/architecture.md §13.3 (domain model), run by the kernel after every
// step with `invariants: "step"` and at checkpoints. Each returns human-readable violations.

import {
  RESOURCE_IDS,
  compareIds,
  type CityId,
  type DeepReadonly,
  type PlayerId,
  type Stationed,
  type UnitCounts,
} from "@perfidia/protocol";
import type { Invariant, ReadCtx } from "@perfidia/engine/contracts";
import { BUILD_QUEUE, sortedIds, storageCap } from "./derive.ts";

const MAX_REPORTS = 20;

type Owner = PlayerId | "neutral";

function capped(out: string[]): readonly string[] {
  return out.length > MAX_REPORTS
    ? [...out.slice(0, MAX_REPORTS), `… ${out.length - MAX_REPORTS} more`]
    : out;
}

/** Every number in the state is a safe integer ≥ 0; island coordinates may be negative. */
const safeInts: Invariant = {
  name: "std.safe-ints",
  level: "step",
  check(r) {
    const out: string[] = [];
    const walk = (value: unknown, path: string, signed: boolean): void => {
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || (!signed && value < 0)) out.push(`${path} = ${value}`);
      } else if (Array.isArray(value)) {
        value.forEach((v: unknown, i) => walk(v, `${path}[${i}]`, false));
      } else if (typeof value === "object" && value !== null) {
        for (const [k, v] of Object.entries(value)) {
          const coordinate = path.startsWith("islands.") && (k === "x" || k === "y");
          walk(v, path === "" ? k : `${path}.${k}`, coordinate);
        }
      }
    };
    walk(r.state, "", false);
    return capped(out.map((p) => `not a safe integer ≥ 0: ${p}`));
  },
};

/** Stock never exceeds the storage cap, and was materialised at or before now. */
const stockCap: Invariant = {
  name: "std.stock-cap",
  level: "step",
  check(r) {
    const out: string[] = [];
    for (const id of sortedIds(r.state.cities)) {
      const c = r.state.cities[id];
      if (c === undefined) continue;
      if (c.stockAt > r.now) out.push(`${id}: stockAt ${c.stockAt} is after now ${r.now}`);
      const capS = storageCap(r, id) * r.rules.resourceScale;
      for (const res of RESOURCE_IDS) {
        if (c.stock[res] > capS) out.push(`${id}: ${res} ${c.stock[res]} above cap ${capS}`);
      }
    }
    return capped(out);
  },
};

/** Batches are consistent with their unit's table: pop, queue, timing, delivered count. */
const recruitBatches: Invariant = {
  name: "std.recruit-batches",
  level: "step",
  check(r) {
    const out: string[] = [];
    for (const id of sortedIds(r.state.cities)) {
      const c = r.state.cities[id];
      if (c === undefined) continue;
      for (const q of r.rules.queues.recruit) {
        for (const b of c.recruit[q.id] ?? []) {
          const where = `${id} #${b.id}`;
          const u = r.rules.units.find((x) => x.id === b.unit);
          if (u === undefined) {
            out.push(`${where}: unknown unit ${b.unit}`);
            continue;
          }
          if (u.queue !== q.id)
            out.push(`${where}: ${b.unit} belongs to queue ${u.queue}, not ${q.id}`);
          if (b.popEach !== u.pop)
            out.push(`${where}: pop ${b.popEach} per unit, table says ${u.pop}`);
          if (b.count < 1 || b.done < 0 || b.done > b.count) {
            out.push(`${where}: done ${b.done} of ${b.count}`);
          }
          if (b.unitTime < 1 || b.end !== b.start + b.count * b.unitTime) {
            out.push(
              `${where}: ${b.count} × ${b.unitTime} s from ${b.start} does not end at ${b.end}`,
            );
          }
        }
      }
    }
    return capped(out);
  },
};

function addCounts(
  into: Record<string, number>,
  units: DeepReadonly<UnitCounts>,
  sign: number,
): void {
  for (const [id, n] of Object.entries(units)) into[id] = (into[id] ?? 0) + sign * (n ?? 0);
}

/** Per owner and unit type: home + stationed + in movements = `ledger.made − ledger.gone`. */
const unitConservation: Invariant = {
  name: "std.unit-conservation",
  level: "step",
  check(r) {
    const balance: Record<string, Record<string, number>> = {};
    const of = (o: Owner): Record<string, number> => (balance[o] ??= {});
    for (const c of Object.values(r.state.cities)) {
      addCounts(of(c.owner ?? "neutral"), c.units, 1);
      for (const g of c.stationed) addCounts(of(g.owner), g.units, 1);
    }
    for (const m of Object.values(r.state.movements)) addCounts(of(m.owner), m.units, 1);
    for (const o of sortedIds(r.state.ledger)) {
      const entry = r.state.ledger[o];
      if (entry === undefined) continue;
      addCounts(of(o), entry.made, -1);
      addCounts(of(o), entry.gone, 1);
    }
    const out: string[] = [];
    for (const o of sortedIds(balance)) {
      for (const unit of sortedIds(balance[o] ?? {})) {
        const diff = balance[o]?.[unit] ?? 0;
        if (diff !== 0) out.push(`${o} ${unit}: present − (made − gone) = ${diff}`);
      }
    }
    return capped(out);
  },
};

function groupKey(g: DeepReadonly<Stationed>): string {
  return `${g.owner}|${g.home}|${g.role}`;
}

function compareGroups(a: DeepReadonly<Stationed>, b: DeepReadonly<Stationed>): number {
  return (
    compareIds(a.owner, b.owner) ||
    compareIds(a.home, b.home) ||
    (a.role === b.role ? 0 : a.role < b.role ? -1 : 1)
  );
}

/** Stationed groups are non-empty, strictly sorted by (owner, home, role), and away from home. */
const stationed: Invariant = {
  name: "std.stationed",
  level: "step",
  check(r) {
    const out: string[] = [];
    for (const id of sortedIds(r.state.cities)) {
      const c = r.state.cities[id];
      if (c === undefined) continue;
      c.stationed.forEach((g, i) => {
        const where = `${id} group ${groupKey(g)}`;
        if (!Object.values(g.units).some((n) => (n ?? 0) > 0)) out.push(`${where} is empty`);
        if (g.home === id) out.push(`${where} is stationed in its own home`);
        if (r.state.cities[g.home] === undefined)
          out.push(`${where}: home ${g.home} does not exist`);
        if (r.state.players[g.owner] === undefined) out.push(`${where}: owner does not exist`);
        const prev = c.stationed[i - 1];
        if (prev !== undefined && compareGroups(prev, g) >= 0) {
          out.push(`${where} is not after ${groupKey(prev)}`);
        }
      });
    }
    return capped(out);
  },
};

/** Every city sits on an existing island, in a slot below its count, alone in that slot. */
const slots: Invariant = {
  name: "std.slots",
  level: "step",
  check(r) {
    const out: string[] = [];
    const taken: Record<string, string> = {};
    for (const id of sortedIds(r.state.cities)) {
      const c = r.state.cities[id];
      if (c === undefined) continue;
      const island = r.state.islands[c.island];
      if (island === undefined) {
        out.push(`${id}: island ${c.island} does not exist`);
        continue;
      }
      if (c.slot >= island.slots)
        out.push(`${id}: slot ${c.slot} of ${c.island} (${island.slots} slots)`);
      const key = `${c.island}:${c.slot}`;
      const other = taken[key];
      if (other !== undefined) out.push(`${id} and ${other} share slot ${c.slot} of ${c.island}`);
      else taken[key] = id;
    }
    return capped(out);
  },
};

/** An eliminated player owns nothing: no city, unit, movement, proposal, alliance or pact. */
const eliminated: Invariant = {
  name: "std.eliminated",
  level: "step",
  check(r) {
    const out: string[] = [];
    for (const p of sortedIds(r.state.players)) {
      const player = r.state.players[p];
      if (player === undefined || player.alive) continue;
      if (player.eliminatedAt === null) out.push(`${p} is eliminated without a time`);
      if (player.alliance !== null) out.push(`${p} is eliminated but in ${player.alliance}`);
      for (const c of Object.values(r.state.cities)) {
        if (c.owner === p) out.push(`${p} is eliminated but owns ${c.id}`);
        if (c.stationed.some((g) => g.owner === p))
          out.push(`${p} is eliminated but has units in ${c.id}`);
      }
      for (const m of Object.values(r.state.movements)) {
        if (m.owner === p) out.push(`${p} is eliminated but moves ${m.id}`);
      }
      for (const q of Object.values(r.state.proposals)) {
        if (q.from === p || q.to === p) out.push(`${p} is eliminated but in proposal ${q.id}`);
      }
      for (const a of Object.values(r.state.alliances)) {
        if (a.members.includes(p)) out.push(`${p} is eliminated but a member of ${a.id}`);
      }
      for (const x of r.state.pacts) {
        if (x.a === p || x.b === p)
          out.push(`${p} is eliminated but in a pact with ${x.a === p ? x.b : x.a}`);
      }
    }
    return capped(out);
  },
};

/** Every attack lasts at least `minTravel` (the speed rule; backs up the creation check of §3.6). */
const attackMinTravel: Invariant = {
  name: "std.attack-min-travel",
  level: "step",
  check(r) {
    const out: string[] = [];
    const min = r.rules.time.minTravel;
    for (const id of sortedIds(r.state.movements)) {
      const m = r.state.movements[id];
      if (m !== undefined && m.kind === "attack" && m.arriveAt - m.departAt < min) {
        out.push(`${id}: attack takes ${m.arriveAt - m.departAt} s, below minTravel ${min}`);
      }
    }
    return capped(out);
  },
};

/** Movements reference existing cities, islands and players, and arrive after they depart. */
const movements: Invariant = {
  name: "std.movements",
  level: "step",
  check(r) {
    const out: string[] = [];
    for (const id of sortedIds(r.state.movements)) {
      const m = r.state.movements[id];
      if (m === undefined) continue;
      if (m.id !== id) out.push(`${id}: record id ${m.id}`);
      if (r.state.players[m.owner] === undefined)
        out.push(`${id}: owner ${m.owner} does not exist`);
      for (const c of [m.home, m.from, ...(m.to === null ? [] : [m.to])]) {
        if (r.state.cities[c] === undefined) out.push(`${id}: city ${c} does not exist`);
      }
      for (const i of [m.fromIsland, m.toIsland]) {
        if (r.state.islands[i] === undefined) out.push(`${id}: island ${i} does not exist`);
      }
      if (m.to === null && m.kind !== "found") out.push(`${id}: a ${m.kind} without a target city`);
      if (m.departAt > r.now || m.arriveAt <= m.departAt) {
        out.push(`${id}: departs ${m.departAt}, arrives ${m.arriveAt}, now ${r.now}`);
      }
    }
    return capped(out);
  },
};

/**
 * Everything homed in a city belongs to its owner: every movement's and every stationed group's
 * home is owned by the movement's or group's owner. An owner change must re-home, disband or
 * eliminate what was homed in the city within the same step (§5.4 `transferCity`); otherwise a
 * return would later reach a home its owner lost, and the former owner's cargo would count in
 * the new owner's shipment cap. Missing homes are `std.movements` and `std.stationed` reports.
 */
const homes: Invariant = {
  name: "std.homes",
  level: "step",
  check(r) {
    const out: string[] = [];
    const check = (where: string, owner: PlayerId, home: CityId): void => {
      const city = r.state.cities[home];
      if (city !== undefined && city.owner !== owner) {
        out.push(`${where} of ${owner} is homed in ${home}, owned by ${city.owner ?? "neutral"}`);
      }
    };
    for (const id of sortedIds(r.state.movements)) {
      const m = r.state.movements[id];
      if (m !== undefined) check(id, m.owner, m.home);
    }
    for (const id of sortedIds(r.state.cities)) {
      for (const g of r.state.cities[id]?.stationed ?? []) {
        check(`${id} group ${groupKey(g)}`, g.owner, g.home);
      }
    }
    return capped(out);
  },
};

/** Every city has every building of the rules, within 0..maxLevel, and no other. */
const buildings: Invariant = {
  name: "std.buildings",
  level: "step",
  check(r) {
    const out: string[] = [];
    for (const id of sortedIds(r.state.cities)) {
      const c = r.state.cities[id];
      if (c === undefined) continue;
      for (const b of r.rules.buildings) {
        const level = c.buildings[b.id];
        if (level === undefined) out.push(`${id}: no level for ${b.id}`);
        else if (level > b.maxLevel) out.push(`${id}: ${b.id} ${level} above max ${b.maxLevel}`);
      }
      for (const b of Object.keys(c.buildings)) {
        if (!r.rules.buildings.some((x) => x.id === b)) out.push(`${id}: unknown building ${b}`);
      }
    }
    return capped(out);
  },
};

/** Queues follow the rules: known queues, items in sequence, within their limits, unique numbers. */
const queues: Invariant = {
  name: "std.queues",
  level: "step",
  check(r) {
    const out: string[] = [];
    const rules = r.rules.queues;
    for (const id of sortedIds(r.state.cities)) {
      const c = r.state.cities[id];
      if (c === undefined) continue;
      const seen: Record<string, true> = {};
      const item = (n: number): void => {
        if (seen[n] === true) out.push(`${id}: item #${n} is used twice`);
        if (n > c.itemSeq) out.push(`${id}: item #${n} above itemSeq ${c.itemSeq}`);
        seen[n] = true;
      };
      if (c.build.length > rules.build.max)
        out.push(`${id}: ${c.build.length} build items, max ${rules.build.max}`);
      let prev = -1;
      for (const it of c.build) {
        item(it.id);
        const table = r.rules.buildings.find((b) => b.id === it.building);
        if (table === undefined) out.push(`${id} #${it.id}: unknown building ${it.building}`);
        else if (it.level > table.maxLevel)
          out.push(`${id} #${it.id}: target ${it.level} above max`);
        if (it.end <= it.start || it.start < prev)
          out.push(`${id} #${it.id}: ${it.start}..${it.end} after ${prev}`);
        prev = it.end;
      }
      for (const q of Object.keys(c.recruit)) {
        if (q === BUILD_QUEUE || !rules.recruit.some((x) => x.id === q))
          out.push(`${id}: unknown queue ${q}`);
      }
      for (const q of rules.recruit) {
        const batches = c.recruit[q.id];
        if (batches === undefined) {
          out.push(`${id}: no recruit queue ${q.id}`);
          continue;
        }
        if (batches.length > q.maxBatches)
          out.push(`${id}: ${batches.length} batches in ${q.id}, max ${q.maxBatches}`);
        let last = -1;
        for (const b of batches) {
          item(b.id);
          if (b.start < last) out.push(`${id} #${b.id}: starts ${b.start} before ${last}`);
          last = b.end;
        }
      }
    }
    return capped(out);
  },
};

/** Unit counts name units of the rules, with counts ≥ 1 (zero entries are omitted). */
const unitsKnown: Invariant = {
  name: "std.units-known",
  level: "step",
  check(r) {
    const out: string[] = [];
    const known = (where: string, units: DeepReadonly<UnitCounts>): void => {
      for (const [u, n] of Object.entries(units)) {
        if (!r.rules.units.some((x) => x.id === u)) out.push(`${where}: unknown unit ${u}`);
        if (n === undefined || n < 1) out.push(`${where}: ${u} count ${n}`);
      }
    };
    for (const id of sortedIds(r.state.cities)) {
      const c = r.state.cities[id];
      if (c === undefined) continue;
      known(`${id} home`, c.units);
      for (const g of c.stationed) known(`${id} group ${groupKey(g)}`, g.units);
    }
    for (const id of sortedIds(r.state.movements)) {
      const m = r.state.movements[id];
      if (m !== undefined) known(id, m.units);
    }
    for (const o of sortedIds(r.state.ledger)) {
      const e = r.state.ledger[o];
      if (e === undefined) continue;
      known(`ledger ${o} made`, e.made);
      known(`ledger ${o} gone`, e.gone);
    }
    return capped(out);
  },
};

/** The std invariants of §13.3, all at step level (step invariants also run at checkpoints). */
export const stdInvariants: readonly Invariant[] = Object.freeze([
  safeInts,
  stockCap,
  recruitBatches,
  unitConservation,
  stationed,
  slots,
  eliminated,
  attackMinTravel,
  movements,
  homes,
  buildings,
  queues,
  unitsKnown,
]);

/** Runs `stdInvariants` and returns every violation, prefixed by the invariant's name. */
export function checkStd(r: ReadCtx): string[] {
  const out: string[] = [];
  for (const inv of stdInvariants) for (const v of inv.check(r)) out.push(`${inv.name}: ${v}`);
  return out;
}
