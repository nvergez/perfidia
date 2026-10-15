import { own } from "@perfidia/engine/core";
import { relation, sortedIds, storageCap } from "@perfidia/engine";
import type { ReadCtx } from "@perfidia/engine/contracts";
import type { Match } from "@perfidia/engine/kernel";
import {
  addAlliance,
  addBuildItem,
  addMovement,
  addProposal,
  addStationed,
  scheduleAt,
} from "@perfidia/engine/testing";
import { copyOf, visibilityOf, type GatewayState } from "@perfidia/gateway";
import type {
  City,
  CityId,
  CompiledRules,
  DeepReadonly,
  DomainEvent,
  GameState,
  MovementId,
  PlayerId,
  Snapshot,
} from "@perfidia/protocol";
import { editSnapshot } from "./kit.ts";

// Data hidden from a seat, for the fog properties P10 and P15 (docs/architecture.md §13.2): a
// staged world around an observer X (an ally, an attack heading to X, and for perfidia-1 a siege
// between two other players, a siege by X with a return of the besieged owner heading home into
// it, an open domination with a running countdown, and the Crown), and
// perturbations of data X cannot see: other players' stock, units at home and queues in cities X
// sees only publicly, movements and proposals between others, other owners' id counters, raw battle
// points within the same public battle score, a siege garrison, the Crown's garrison and stock, an
// ally's outgoing movement where the ruleset hides it, where a return into a city X besieges comes
// from (a stationed recall or a bounce, perfidia-1 §12), and the other seats' gateway state. Each
// perturbation is a plain edit of the snapshot state that keeps every invariant (the testing kit's
// builders count units in the ledger and schedule events), applied after the staging, so no id X
// can see changes.

type Rules = DeepReadonly<CompiledRules>;

/** The perfidia-1 versions: the staging below edits their `ext`, which 1.1.0 extends. */
const PERFIDIA: ReadonlySet<string> = new Set(["perfidia-1@1.0.0", "perfidia-1@1.1.0"]);
/** perfidia-1@1.1.0 and later: conquest records (who took a city, its former owners). */
const CONQUESTS: ReadonlySet<string> = new Set(["perfidia-1@1.1.0"]);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function must<V>(rec: Readonly<Record<string, V>>, key: string): V {
  const v = own(rec, key);
  if (v === undefined) throw new Error(`hidden: no ${key}`);
  return v;
}

function capitalOf(state: GameState, p: PlayerId): City | undefined {
  return Object.values(state.cities).find((c) => c.capitalOf === p);
}

const alive = (state: GameState): PlayerId[] =>
  sortedIds(state.players).filter((p) => state.players[p]?.alive === true);

/** The perfidia-1 `ext` as plain JSON, for editing. */
interface PExt {
  sieges: Record<string, { by: string; startedAt: number; endsAt: number; seq: number }>;
  /** perfidia-1@1.1.0. */
  conquests?: Record<string, { by: string; former: string[] }>;
  battlePoints: Record<string, number>;
  domination: {
    open: boolean;
    countdowns: {
      bloc: string;
      members: string[];
      startedAt: number;
      endsAt: number;
      seq: number;
    }[];
  };
}

function pext(state: GameState): PExt {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- perfidia-1's ext, read only in perfidia-1 worlds
  return state.ext as unknown as PExt;
}

/** The staged world around observer `x`. */
export interface Staged {
  readonly snap: Snapshot;
  readonly x: PlayerId;
  readonly ally: PlayerId | null;
  /** An attack of another player heading to X's capital (X sees it as incoming). */
  readonly attackOnX: MovementId | null;
  /** perfidia-1: the besieged city, its owner and besieger (neither X nor an ally of X). */
  readonly siege: { city: CityId; owner: PlayerId; by: PlayerId } | null;
  /** A support of X's ally, made of units from the ally's home, to a city X sees only publicly. */
  readonly allyMovement: MovementId | null;
  /**
   * perfidia-1: a stranger's capital that X besieges, and a return of that stranger heading home
   * into it (a coming homecoming battle, announced to X: X is its party).
   */
  readonly xSiege: { city: CityId; owner: PlayerId; returning: MovementId } | null;
}

/**
 * Moves `count` units of `unit` from the home of `from` (owned by `owner`) into a support to `to`
 * arriving at `arriveAt`: the units leave home, so the ledger is unchanged.
 */
function sendSupport(
  state: GameState,
  rules: Rules,
  o: {
    owner: PlayerId;
    from: CityId;
    to: CityId;
    unit: string;
    count: number;
    arriveAt: number;
    idKey: string;
  },
): MovementId {
  const home = must(state.cities, o.from);
  home.units[o.unit] = (home.units[o.unit] ?? 0) - o.count;
  if (home.units[o.unit] === 0) delete home.units[o.unit];
  const m = addMovement(state, rules, {
    kind: "support",
    owner: o.owner,
    from: o.from,
    to: o.to,
    units: { [o.unit]: o.count },
    arriveAt: o.arriveAt,
    idKey: o.idKey,
  });
  const made = must(state.ledger, o.owner).made;
  made[o.unit] = (made[o.unit] ?? 0) - o.count;
  return m.id;
}

/**
 * Stages the world of `snap` around `x` (in both states compared): an ally (X's alliance partner, or
 * a new alliance with a player without alliance or pact with X) with a support under way to a
 * stranger's city, an attack on X's capital, and for perfidia-1 a siege and an open domination with
 * a countdown for a lone player. That countdown's bloc does not qualify, so the next step of the
 * match cancels it: `countdown: false` leaves it out where steps are compared (P15).
 */
export function stage(
  snap: Snapshot,
  x: PlayerId,
  rules: Rules,
  o: { readonly countdown?: boolean } = {},
): Staged {
  let ally: PlayerId | null = null;
  let attackOnX: MovementId | null = null;
  let siege: Staged["siege"] = null;
  let allyMovement: MovementId | null = null;
  let xSiege: Staged["xSiege"] = null;
  const idKey = snap.setup.idKey;
  const staged = editSnapshot(snap, (state) => {
    const players = alive(state);
    const xs = must(state.players, x);
    if (xs.alliance !== null) {
      ally = must(state.alliances, xs.alliance).members.find((p) => p !== x) ?? null;
    } else {
      const pacted = new Set(
        state.pacts.flatMap((p) => (p.a === x ? [p.b] : p.b === x ? [p.a] : [])),
      );
      const free = players.find(
        (p) =>
          p !== x &&
          state.players[p]?.alliance === null &&
          !pacted.has(p) &&
          capitalOf(state, p) !== undefined,
      );
      if (free !== undefined && rules.diplomacy.allianceMax >= 2) {
        addAlliance(state, `Staged ${x}`, [x, free]);
        ally = free;
      }
    }
    const friends = new Set<string>([x, ...(ally === null ? [] : [ally])]);
    const xa = state.players[x]?.alliance ?? null;
    if (xa !== null) for (const m of must(state.alliances, xa).members) friends.add(m);
    const strangers = players.filter((p) => !friends.has(p) && capitalOf(state, p) !== undefined);
    const xCap = capitalOf(state, x);
    const enemy = strangers[0];
    if (xCap !== undefined && enemy !== undefined) {
      const from = must(state.cities, capitalOf(state, enemy)?.id ?? "");
      const unit = rules.units.find((u) => u.domain === "land" && u.attack > 0)?.id ?? "x";
      const m = addMovement(state, rules, {
        kind: "attack",
        owner: enemy,
        from: from.id,
        to: xCap.id,
        units: { [unit]: 3 },
        party: x,
        arriveAt: state.now + Math.max(rules.time.minTravel, 7200),
        idKey,
      });
      attackOnX = m.id;
    }
    const allyCap = ally === null ? undefined : capitalOf(state, ally);
    const target = strangers.at(-1);
    const targetCap = target === undefined ? undefined : capitalOf(state, target);
    const sent =
      allyCap === undefined
        ? undefined
        : Object.entries(allyCap.units).find(([u, n]) => n >= 2 && u !== rules.roles.settler);
    if (ally !== null && allyCap !== undefined && targetCap !== undefined && sent !== undefined) {
      allyMovement = sendSupport(state, rules, {
        owner: ally,
        from: allyCap.id,
        to: targetCap.id,
        unit: sent[0],
        count: 2,
        arriveAt: state.now + 5400,
        idKey,
      });
    }
    if (!PERFIDIA.has(snap.setup.ruleset)) return;
    const fighter = rules.units.find((u) => u.domain === "land" && u.attack > 0)?.id ?? "x";
    /** A siege of `owner`'s capital by `by`, held from `by`'s capital; returns the city. */
    const besiege = (owner: PlayerId, by: PlayerId): City => {
      const city = must(state.cities, capitalOf(state, owner)?.id ?? "");
      const home = must(state.cities, capitalOf(state, by)?.id ?? "");
      const seqs = new Set([
        ...city.build.map((b) => b.seq),
        ...Object.values(city.recruit).flatMap((q) => q.map((b) => b.seq)),
      ]);
      state.queue = state.queue.filter((ev) => !seqs.has(ev.seq));
      city.build = [];
      for (const q of Object.keys(city.recruit)) city.recruit[q] = [];
      addStationed(state, city.id, {
        owner: by,
        home: home.id,
        role: "hold",
        units: { [rules.roles.settler]: 1, [fighter]: 5 },
      });
      const endsAt = state.now + 21600;
      const seq = scheduleAt(state, rules, "siege_end", endsAt, city.id);
      pext(state).sieges[city.id] = { by, startedAt: state.now, endsAt, seq };
      // A siege start tells the besieger of every return already heading into the city (perfidia-1
      // §9.3, `announceHomecoming`): those returns record it as their party. Left untold, the
      // engine would tell them at the next step, whose time depends on data hidden from X.
      for (const mv of Object.values(state.movements)) {
        if (mv.kind === "return" && mv.home === city.id && mv.owner !== by) mv.party = by;
      }
      return city;
    };
    // A siege of the capital of one stranger by another, outside X's alliance.
    const [owner, by] = [strangers[1], strangers[2]];
    if (owner !== undefined && by !== undefined) {
      siege = { city: besiege(owner, by).id, owner, by };
    }
    // A siege by X of a fourth stranger's capital, with a return of that stranger heading home
    // into it from a city X sees only publicly: X sees it coming, never where from.
    const held = strangers[3];
    if (held !== undefined && held !== target && xCap !== undefined) {
      const city = besiege(held, x);
      const origin = Object.values(state.cities)
        .filter(
          (c) =>
            c.owner !== null &&
            !friends.has(c.owner) &&
            c.id !== city.id &&
            c.id !== siege?.city &&
            c.island !== city.island,
        )
        .toSorted((a, b) => byText(a.id, b.id))[0];
      if (origin !== undefined) {
        const m = addMovement(state, rules, {
          kind: "return",
          owner: held,
          from: origin.id,
          to: city.id,
          home: city.id,
          party: x,
          units: { [fighter]: 4 },
          departAt: state.now - 100,
          arriveAt: state.now + Math.max(rules.time.minTravel, 9000),
          idKey,
        });
        xSiege = { city: city.id, owner: held, returning: m.id };
      }
    }
    // An open domination with a countdown for a lone player.
    const d = pext(state).domination;
    if (!d.open) {
      d.open = true;
      state.queue = state.queue.filter((ev) => ev.kind !== "domination_open");
    }
    const lone = alive(state).find(
      (p) => state.players[p]?.alliance === null && !d.countdowns.some((c) => c.bloc === p),
    );
    if (lone !== undefined && o.countdown !== false) {
      const endsAt = state.now + 86400;
      const seq = scheduleAt(state, rules, "domination_end", endsAt, lone);
      d.countdowns.push({ bloc: lone, members: [lone], startedAt: state.now, endsAt, seq });
      d.countdowns.sort((a, b) => byText(a.bloc, b.bloc));
    }
    // 1.1.0: a city its owner took from another player (public, from `city_conquered`), so the
    // views show a taken city, its former owner and the players' and blocs' taken counts. A city
    // of a stranger to X that is no capital when there is one, else a stranger's capital.
    const x11 = pext(state);
    if (CONQUESTS.has(snap.setup.ruleset) && x11.conquests !== undefined) {
      const owned = Object.values(state.cities)
        .filter((c) => c.owner !== null && c.owner !== x && !friends.has(c.owner))
        .toSorted(
          (a, b) =>
            Number(a.capitalOf !== null) - Number(b.capitalOf !== null) || byText(a.id, b.id),
        );
      const taken = owned[0];
      const from = alive(state).find((p) => p !== taken?.owner);
      if (taken?.owner !== null && taken?.owner !== undefined && from !== undefined) {
        x11.conquests[taken.id] = { by: taken.owner, former: [from] };
      }
    }
  });
  return { snap: staged, x, ally, attackOnX, siege, allyMovement, xSiege };
}

/** One perturbation of data hidden from X; `pick` selects among the eligible targets. */
export type Perturbation =
  | { readonly kind: "stock"; readonly pick: number; readonly amount: number }
  | { readonly kind: "units"; readonly pick: number; readonly count: number }
  | { readonly kind: "build"; readonly pick: number }
  | {
      readonly kind: "support";
      readonly pick: number;
      readonly count: number;
      readonly arriveIn: number;
    }
  | { readonly kind: "proposal"; readonly pick: number }
  | { readonly kind: "dropProposal"; readonly pick: number }
  | {
      readonly kind: "counters";
      readonly pick: number;
      readonly m: number;
      readonly r: number;
      readonly q: number;
      readonly g: number;
    }
  | { readonly kind: "battlePoints"; readonly pick: number; readonly units: number }
  | { readonly kind: "garrison"; readonly count: number }
  | { readonly kind: "crown"; readonly amount: number; readonly count: number }
  | { readonly kind: "reschedule" }
  | { readonly kind: "allyOutgoing"; readonly pick: number; readonly arriveIn: number }
  | { readonly kind: "returnOrigin"; readonly pick: number };

/** Edits of the other seats' gateway state. */
export type GwEdit =
  | { readonly kind: "note"; readonly pick: number; readonly text: string }
  | {
      readonly kind: "day";
      readonly pick: number;
      readonly attacks: number;
      readonly messages: number;
    }
  | { readonly kind: "archive"; readonly pick: number; readonly n: number };

/** Cities X sees only publicly (the Crown included), other than the staged sieges'. */
function hiddenCities(r: ReadCtx, s: Staged): DeepReadonly<City>[] {
  const vis = visibilityOf(r);
  return sortedIds(r.state.cities)
    .filter(
      (c) => vis.cityAccess(s.x, c) === "public" && c !== s.siege?.city && c !== s.xSiege?.city,
    )
    .map((c) => must(r.state.cities, c));
}

/** Players other than X and X's allies. */
function strangersOf(r: ReadCtx, x: PlayerId): PlayerId[] {
  return sortedIds(r.state.players).filter(
    (p) =>
      r.state.players[p]?.alive === true &&
      relation(r, x, p) !== "self" &&
      relation(r, x, p) !== "ally",
  );
}

const at = <T>(list: readonly T[], pick: number): T | undefined =>
  list.length === 0 ? undefined : list[pick % list.length];

/**
 * Applies `list` to a copy of the staged snapshot (read through `r`, the staged match) and returns
 * the perturbed snapshot and how many perturbations found a target. The data of the players in
 * `exclude` (the actor of the step P15 compares) is left alone: their cities, movements, proposals,
 * counters, battle points, sieges and alliance.
 */
export function perturb(
  s: Staged,
  r: ReadCtx,
  list: readonly Perturbation[],
  exclude: readonly PlayerId[] = [],
): { snap: Snapshot; applied: number } {
  const rules = r.rules;
  const idKey = s.snap.setup.idKey;
  const spared = new Set<string>(exclude);
  const hidden = hiddenCities(r, s).filter((c) => c.owner === null || !spared.has(c.owner));
  const strangers = strangersOf(r, s.x).filter((p) => !spared.has(p));
  const siege =
    s.siege !== null && (spared.has(s.siege.by) || spared.has(s.siege.owner)) ? null : s.siege;
  const ally = s.ally !== null && spared.has(s.ally) ? null : s.ally;
  const xSiege = s.xSiege !== null && spared.has(s.xSiege.owner) ? null : s.xSiege;
  let allyMove = s.allyMovement;
  const scale = rules.resourceScale;
  let applied = 0;
  const snap = editSnapshot(s.snap, (state) => {
    for (const p of list) {
      switch (p.kind) {
        case "stock": {
          const c = at(hidden, p.pick);
          if (c === undefined) break;
          const cap = storageCap(r, c.id) * scale;
          const city = must(state.cities, c.id);
          city.stock.wood = Math.min(cap, p.amount * scale);
          city.stock.gold = Math.min(cap, (p.amount % 97) * scale);
          applied += 1;
          break;
        }
        case "units": {
          const c = at(hidden, p.pick);
          if (c === undefined) break;
          const unit = rules.units[p.pick % rules.units.length]?.id ?? "x";
          const city = must(state.cities, c.id);
          city.units[unit] = (city.units[unit] ?? 0) + p.count;
          const ledger = must(state.ledger, c.owner ?? "neutral");
          ledger.made[unit] = (ledger.made[unit] ?? 0) + p.count;
          applied += 1;
          break;
        }
        case "build": {
          const c = at(
            hidden.filter((x) => x.owner !== null),
            p.pick,
          );
          if (c === undefined) break;
          const city = must(state.cities, c.id);
          if (city.build.length >= rules.queues.build.max) break;
          const b = rules.buildings.find((x) => {
            const queued = city.build.filter((i) => i.building === x.id).length;
            return (city.buildings[x.id] ?? 0) + queued + 1 <= x.maxLevel;
          });
          if (b === undefined) break;
          addBuildItem(state, rules, c.id, b.id);
          applied += 1;
          break;
        }
        case "support": {
          // Nothing leaves a besieged city (perfidia-1 §9.2): its owner sends no support from it.
          const besieged = (q: PlayerId): boolean =>
            PERFIDIA.has(s.snap.setup.ruleset) &&
            Object.hasOwn(pext(state).sieges, capitalOf(state, q)?.id ?? "");
          const mover = at(
            strangers.filter((q) => !besieged(q)),
            p.pick,
          );
          const target = at(
            hidden.filter((x) => x.owner !== null && x.owner !== mover),
            p.pick + 1,
          );
          const from = mover === undefined ? undefined : capitalOf(state, mover);
          if (mover === undefined || target === undefined || from === undefined) break;
          const unit = rules.units.find((u) => u.domain === "land")?.id ?? "x";
          addMovement(state, rules, {
            kind: "support",
            owner: mover,
            from: from.id,
            to: target.id,
            units: { [unit]: p.count },
            arriveAt: state.now + p.arriveIn,
            idKey,
          });
          applied += 1;
          break;
        }
        case "proposal": {
          const from = at(strangers, p.pick);
          const to = at(
            strangers.filter((q) => q !== from),
            p.pick + 1,
          );
          if (from === undefined || to === undefined) break;
          const kind = p.pick % 2 === 0 ? "pact" : "alliance";
          const open = Object.values(state.proposals).filter((q) => q.from === from);
          const same = open.some((q) => q.to === to && q.kind === kind);
          // A valid hidden state: within the open-proposal limit (bots may already be at it).
          if (same || open.length >= rules.diplomacy.maxOpenProposals) break;
          addProposal(state, rules, { from, to, kind, idKey });
          applied += 1;
          break;
        }
        case "dropProposal": {
          const q = at(
            sortedIds(state.proposals).filter((id) => {
              const prop = must(state.proposals, id);
              return (
                prop.from !== s.x &&
                prop.to !== s.x &&
                !spared.has(prop.from) &&
                !spared.has(prop.to)
              );
            }),
            p.pick,
          );
          if (q === undefined) break;
          delete state.proposals[q];
          state.queue = state.queue.filter(
            (ev) => !(ev.kind === "proposal_expire" && ev.ref === q),
          );
          applied += 1;
          break;
        }
        case "counters": {
          const other = at(
            sortedIds(state.players).filter((x) => x !== s.x && !spared.has(x)),
            p.pick,
          );
          if (other === undefined) break;
          const c = must(state.ids.own, other);
          c.m += p.m;
          c.r += p.r;
          c.q += p.q;
          c.g += p.g;
          applied += 1;
          break;
        }
        case "battlePoints": {
          if (!PERFIDIA.has(s.snap.setup.ruleset)) break;
          const other = at(
            sortedIds(state.players).filter((x) => x !== s.x && !spared.has(x)),
            p.pick,
          );
          if (other === undefined) break;
          const bp = pext(state).battlePoints;
          const old = bp[other] ?? 0;
          // Same decade: the public battle score min(floor(bp / 10), …) cannot change.
          bp[other] = old - (old % 10) + (p.units % 10);
          applied += 1;
          break;
        }
        case "garrison": {
          if (siege === null) break;
          const city = must(state.cities, siege.city);
          const group = city.stationed.find((g) => g.owner === siege.by && g.role === "hold");
          if (group === undefined) break;
          const unit =
            rules.units.find((u) => u.domain === "land" && u.id !== rules.roles.settler)?.id ?? "x";
          group.units[unit] = (group.units[unit] ?? 0) + p.count;
          const ledger = must(state.ledger, siege.by);
          ledger.made[unit] = (ledger.made[unit] ?? 0) + p.count;
          applied += 1;
          break;
        }
        case "reschedule": {
          // The seqs of the staged siege's `siege_end` and of each countdown's `domination_end`:
          // engine bookkeeping (§5.1), never shown. Each event is scheduled again, with a new seq.
          if (!PERFIDIA.has(s.snap.setup.ruleset)) break;
          const x = pext(state);
          const again = (kind: string, ref: string, seq: number): number => {
            const ev = state.queue.find((e) => e.seq === seq);
            if (ev === undefined) throw new Error(`hidden: no ${kind} event with seq ${seq}`);
            state.queue = state.queue.filter((e) => e.seq !== seq);
            return scheduleAt(state, rules, kind, ev.at, ref);
          };
          if (siege !== null) {
            const rec = x.sieges[siege.city];
            if (rec !== undefined) rec.seq = again("siege_end", siege.city, rec.seq);
          }
          for (const c of x.domination.countdowns) c.seq = again("domination_end", c.bloc, c.seq);
          applied += 1;
          break;
        }
        case "crown": {
          const crown = Object.values(state.cities).find((c) => c.owner === null);
          if (crown === undefined) break;
          const cap = storageCap(r, crown.id) * scale;
          crown.stock.stone = Math.min(cap, p.amount * scale);
          const unit = Object.keys(crown.units).toSorted(byText)[0] ?? rules.units[0]?.id ?? "x";
          crown.units[unit] = (crown.units[unit] ?? 0) + p.count;
          const ledger = must(state.ledger, "neutral");
          ledger.made[unit] = (ledger.made[unit] ?? 0) + p.count;
          applied += 1;
          break;
        }
        case "allyOutgoing": {
          // Where X's ally's support goes and when it lands: hidden where the ruleset hides an
          // ally's outgoing movements (perfidia-1; sandbox-1 shows them in full).
          if (!PERFIDIA.has(s.snap.setup.ruleset) || allyMove === null || ally === null) break;
          const m = must(state.movements, allyMove);
          const to = at(
            hidden.filter((c) => c.owner !== null && c.owner !== ally && c.id !== m.to),
            p.pick,
          );
          if (to === undefined) break;
          delete state.movements[m.id];
          state.queue = state.queue.filter((ev) => ev.seq !== m.seq);
          const [unit, count] = Object.entries(m.units)[0] ?? ["x", 0];
          must(state.cities, m.from).units[unit] =
            (must(state.cities, m.from).units[unit] ?? 0) + count;
          allyMove = sendSupport(state, rules, {
            owner: ally,
            from: m.from,
            to: to.id,
            unit,
            count,
            arriveAt: state.now + p.arriveIn,
            idKey,
          });
          applied += 1;
          break;
        }
        case "returnOrigin": {
          // Where the return into the city X besieges comes from: a city where its owner had troops
          // stationed (a stationed recall, a dismissal) or the target of a movement that bounced.
          // Its id, owner, party and times stay: perfidia-1 §12 shows the besieger only those.
          if (xSiege === null) break;
          const m = must(state.movements, xSiege.returning);
          const from = at(
            hidden.filter((c) => c.id !== m.from && c.island !== m.toIsland),
            p.pick,
          );
          if (from === undefined) break;
          m.from = from.id;
          m.fromIsland = from.island;
          applied += 1;
          break;
        }
      }
    }
  });
  return { snap, applied };
}

/** The movements of `m` that X cannot see at all (`movementAccess` is `null`). */
export function hiddenMovements(m: Match, x: PlayerId): MovementId[] {
  const r = m.read();
  const vis = visibilityOf(r);
  return sortedIds(r.state.movements).filter((id) => vis.movementAccess(x, id) === null);
}

/** A copy of `gw` with the other seats' gateway state edited. */
export function editGateway(
  gw: GatewayState,
  x: PlayerId,
  edits: readonly GwEdit[],
  now: number,
): GatewayState {
  const copy = copyOf(gw);
  const others = Object.values(copy.seats)
    .map((s) => s.seat)
    .filter((p) => p !== x)
    .toSorted(byText);
  for (const e of edits) {
    const seat = at(others, e.pick);
    if (seat === undefined) continue;
    const s = must(copy.seats, seat);
    if (e.kind === "note") s.notes = e.text;
    else if (e.kind === "day") {
      s.day.attacks = e.attacks;
      s.day.messages = e.messages;
    } else {
      // A private event between two other seats, already in their archives (no new delivery).
      const other = at(
        others.filter((p) => p !== seat),
        e.n,
      );
      if (other === undefined) continue;
      const event: DomainEvent = {
        t: now,
        type: "message",
        public: false,
        to: [
          { p: seat, as: "self" },
          { p: other, as: "target" },
        ],
        data: { from: seat, to: [other], text: `secret ${e.n}`, message: "g00000" },
      };
      const d = { e: e.n % Math.max(1, copy.delivered), event };
      s.archive.push(d);
      must(copy.seats, other).archive.push(d);
    }
  }
  return copy;
}
