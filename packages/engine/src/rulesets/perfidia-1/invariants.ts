import type { Invariant, ReadCtx } from "@perfidia/engine/contracts";
import { sortedIds } from "@perfidia/engine/std";
import { compareIds, type DeepReadonly } from "@perfidia/protocol";
import { countIn, own, sameMembers } from "./common.ts";
import { blocsOf } from "./domination.ts";
import { type PerfidiaExt, PerfidiaExtSchema } from "./ext.ts";
import { DOMINATION_OPEN } from "./map.ts";
import { SIEGE_END } from "./siege.ts";
import { DOMINATION_END } from "./victory.ts";

// perfidia-1's own invariants (docs/architecture.md §13.3), run with the kernel's and std's: every
// siege has a `hold` garrison with a settler and empty queues, every `siege_end` and
// `domination_end` event matches its `ext` record (and back), countdown membership matches the
// bloc, and the ruleset's bookkeeping in `ext` refers to the match's players.

const MAX_REPORTS = 20;

function capped(out: readonly string[]): readonly string[] {
  return out.length > MAX_REPORTS
    ? [...out.slice(0, MAX_REPORTS), `… ${out.length - MAX_REPORTS} more`]
    : out;
}

function pairPlayers(key: string): string[] {
  return key.split("|");
}

/** `state.ext` when it has perfidia-1's shape; the kernel's `kernel.ext` reports it otherwise. */
function extOf(r: ReadCtx): DeepReadonly<PerfidiaExt> | null {
  const parsed = PerfidiaExtSchema.safeParse(r.state.ext);
  return parsed.success ? parsed.data : null;
}

/**
 * Sieges: the city exists and its owner is not the besieger; the besieger is alive; its garrison
 * holds at least one settler; the city's queues are empty. Every `hold` group anywhere belongs to
 * the siege of its city by its owner.
 */
const sieges: Invariant = {
  name: "perfidia-1.sieges",
  level: "step",
  check(r) {
    const x = extOf(r);
    if (x === null) return [];
    const out: string[] = [];
    const settler = r.rules.roles.settler;
    for (const id of sortedIds(x.sieges)) {
      const siege = own(x.sieges, id);
      const city = own(r.state.cities, id);
      if (siege === undefined) continue;
      if (city === undefined) {
        out.push(`siege of ${id}: no such city`);
        continue;
      }
      if (city.owner === siege.by) out.push(`siege of ${id}: ${siege.by} besieges its own city`);
      if (own(r.state.players, siege.by)?.alive !== true) {
        out.push(`siege of ${id}: the besieger ${siege.by} is not an alive player`);
      }
      const garrison = city.stationed.filter((g) => g.owner === siege.by && g.role === "hold");
      if (countIn(garrison, settler) < 1)
        out.push(`siege of ${id}: the garrison has no ${settler}`);
      const queued =
        city.build.length + Object.values(city.recruit).reduce((n, q) => n + q.length, 0);
      if (queued > 0) out.push(`siege of ${id}: ${queued} queue items in a besieged city`);
    }
    for (const id of sortedIds(r.state.cities)) {
      for (const g of own(r.state.cities, id)?.stationed ?? []) {
        if (g.role === "hold" && own(x.sieges, id)?.by !== g.owner) {
          out.push(`${id}: a hold group of ${g.owner} from ${g.home} without its siege`);
        }
      }
    }
    return capped(out);
  },
};

/** Every `siege_end` event matches a siege (ref, seq, time), and every siege has its event. */
const siegeEvents: Invariant = {
  name: "perfidia-1.siege-events",
  level: "step",
  check(r) {
    const x = extOf(r);
    if (x === null) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const ev of r.state.queue) {
      if (ev.kind !== SIEGE_END) continue;
      const siege = own(x.sieges, ev.ref);
      if (siege === undefined) out.push(`siege_end (seq ${ev.seq}): ${ev.ref} is not besieged`);
      else if (siege.seq !== ev.seq || siege.endsAt !== ev.at) {
        out.push(
          `siege_end (seq ${ev.seq}, at ${ev.at}) of ${ev.ref}: the siege has seq ${siege.seq}, ends at ${siege.endsAt}`,
        );
      } else seen.add(ev.ref);
    }
    for (const id of sortedIds(x.sieges)) {
      if (!seen.has(id)) out.push(`siege of ${id}: no matching siege_end event`);
    }
    return capped(out);
  },
};

/**
 * Domination: countdowns only once open, sorted and unique by bloc; each matches its
 * `domination_end` event and every such event its countdown; while running, a countdown's members
 * are its bloc's current members; no `domination_open` timer once open, and at most one before.
 */
const domination: Invariant = {
  name: "perfidia-1.domination",
  level: "step",
  check(r) {
    const x = extOf(r);
    if (x === null) return [];
    const out: string[] = [];
    const d = x.domination;
    if (!d.open && d.countdowns.length > 0) out.push("countdowns run while domination is closed");
    d.countdowns.forEach((c, i) => {
      const prev = d.countdowns[i - 1];
      if (prev !== undefined && compareIds(prev.bloc, c.bloc) >= 0) {
        out.push(`countdown of ${c.bloc} is not after ${prev.bloc}`);
      }
    });
    const opens = r.state.queue.filter((e) => e.kind === DOMINATION_OPEN).length;
    if (d.open && opens > 0) out.push("domination is open but domination_open is still queued");
    if (opens > 1) out.push(`${opens} domination_open events are queued`);
    const seen = new Set<string>();
    for (const ev of r.state.queue) {
      if (ev.kind !== DOMINATION_END) continue;
      const c = d.countdowns.find((cd) => cd.bloc === ev.ref);
      if (c === undefined) out.push(`domination_end (seq ${ev.seq}): ${ev.ref} has no countdown`);
      else if (c.seq !== ev.seq || c.endsAt !== ev.at) {
        out.push(
          `domination_end (seq ${ev.seq}, at ${ev.at}) of ${ev.ref}: the countdown has seq ${c.seq}, ends at ${c.endsAt}`,
        );
      } else seen.add(ev.ref);
    }
    for (const c of d.countdowns) {
      if (!seen.has(c.bloc)) out.push(`countdown of ${c.bloc}: no matching domination_end event`);
    }
    if (r.state.status === "running") {
      const blocs = blocsOf(r.state);
      for (const c of d.countdowns) {
        const bloc = blocs.find((b) => b.key === c.bloc);
        if (bloc === undefined) out.push(`countdown of ${c.bloc}: the bloc no longer exists`);
        else if (!sameMembers(bloc.members, c.members)) {
          out.push(
            `countdown of ${c.bloc}: members ${c.members.join(",")}, the bloc has ${bloc.members.join(",")}`,
          );
        }
      }
    }
    return capped(out);
  },
};

/**
 * The bookkeeping refers to the match's players: the tie-break order is a permutation of them,
 * battle points are kept for players only, related pairs are sorted pairs of players, and no
 * relation ended in the future.
 */
const bookkeeping: Invariant = {
  name: "perfidia-1.bookkeeping",
  level: "step",
  check(r) {
    const x = extOf(r);
    if (x === null) return [];
    const out: string[] = [];
    const players = sortedIds(r.state.players);
    const order = x.tiebreak.toSorted(compareIds);
    if (!sameMembers(order, players)) {
      out.push(`tie-break order ${x.tiebreak.join(",")} is not a permutation of the players`);
    }
    for (const p of sortedIds(x.battlePoints)) {
      if (!players.includes(p)) out.push(`battle points of ${p}, who is not a player`);
    }
    x.related.forEach((key, i) => {
      if (!pairPlayers(key).every((p) => own(r.state.players, p) !== undefined)) {
        out.push(`related pair ${key} names a non-player`);
      }
      const prev = x.related[i - 1];
      if (prev !== undefined && prev === key) out.push(`related pair ${key} is listed twice`);
    });
    for (const key of sortedIds(x.relationEnds)) {
      const t = own(x.relationEnds, key);
      if (t !== undefined && t > r.now) out.push(`relation ${key} ended at ${t}, after now`);
    }
    return capped(out);
  },
};

/** `hooks.invariants` of perfidia-1, all at step level. */
export const perfidiaInvariants: readonly Invariant[] = Object.freeze([
  sieges,
  siegeEvents,
  domination,
  bookkeeping,
]);
