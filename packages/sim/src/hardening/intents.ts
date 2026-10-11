import { createMatch, sortedIds, unitsAtHome, type AnyRuleset } from "@perfidia/engine";
import type { ReadCtx } from "@perfidia/engine/contracts";
import { randInt, type Rng } from "@perfidia/engine/core";
import { domain } from "@perfidia/engine/domain";
import type { InvariantLevel, Match } from "@perfidia/engine/kernel";
import { addCity, addStationed, matchFromState } from "@perfidia/engine/testing";
import type {
  Action,
  City,
  CityId,
  IslandId,
  Json,
  PlayerId,
  UnitCounts,
} from "@perfidia/protocol";
import { setupFor } from "../harness/index.ts";

// Engine action intents for P4 and P15 (docs/architecture.md §13.2): actions resolved against the
// current state so that most are valid, plus schema-valid junk, and a staged start where recalls
// meet stationed groups from several homes and dismissals have guests to send home.

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const pick = <T>(rng: Rng, list: readonly T[]): T | undefined =>
  list.length === 0 ? undefined : list[randInt(rng, 0, list.length - 1)];

export const percent = (rng: Rng, p: number): boolean => randInt(rng, 0, 99) < p;

/**
 * A match of `ruleset` from its real start for `players` seats, plus: every building of every
 * capital raised to at least `levels` (so every unit can be recruited from the start), a second
 * city for p1 and for p4, a support group from each of their two cities stationed in the capital of
 * p2 and of p5, and a support group of p3 in p1's capital. Edits outside the action pipeline stay
 * consistent with the invariants (the testing kit's builders count every unit in the ledger).
 */
export function stagedStart(
  ruleset: AnyRuleset,
  seed: number,
  players: number,
  o: {
    readonly overrides?: Readonly<Record<string, Json>>;
    readonly invariants?: InvariantLevel;
    readonly levels?: number;
  } = {},
): Match {
  const setup = setupFor(ruleset, { seed, players, days: 1, overrides: o.overrides ?? {} });
  const base = createMatch(setup, ruleset);
  const state = base.snapshot(0).state;
  const rules = base.rules;
  const levels = o.levels ?? 0;
  for (const c of Object.values(state.cities)) {
    if (c.capitalOf === null) continue;
    for (const b of rules.buildings) {
      c.buildings[b.id] = Math.max(c.buildings[b.id] ?? 0, Math.min(levels, b.maxLevel));
    }
  }
  const capital = (p: PlayerId): City => {
    const c = Object.values(state.cities).find((x) => x.capitalOf === p);
    if (c === undefined) throw new Error(`no capital for ${p}`);
    return c;
  };
  const freeSlot = (): { island: IslandId; slot: number } => {
    for (const island of sortedIds(state.islands)) {
      const taken = new Set(
        Object.values(state.cities)
          .filter((c) => c.island === island)
          .map((c) => c.slot),
      );
      const slots = state.islands[island]?.slots ?? 0;
      const slot = Array.from({ length: slots }, (_, i) => i).find((i) => !taken.has(i));
      if (slot !== undefined) return { island, slot };
    }
    throw new Error("no free slot");
  };
  const firstUnit = (c: City): string =>
    Object.keys(c.units).toSorted(byText)[0] ?? rules.units[0]?.id ?? "x";
  for (const [owner, host] of [
    ["p1", "p2"],
    ["p4", "p5"],
  ] as const) {
    if (!Object.hasOwn(state.players, owner) || !Object.hasOwn(state.players, host)) continue;
    const home = capital(owner);
    const unit = firstUnit(home);
    const second = addCity(state, rules, {
      owner,
      ...freeSlot(),
      buildings: { ...home.buildings },
      stock: 300,
      units: { [unit]: 6 },
    });
    const at = capital(host).id;
    addStationed(state, at, { owner, home: home.id, role: "support", units: { [unit]: 4 } });
    addStationed(state, at, { owner, home: second.id, role: "support", units: { [unit]: 4 } });
  }
  if (Object.hasOwn(state.players, "p3")) {
    const p3 = capital("p3");
    addStationed(state, capital("p1").id, {
      owner: "p3",
      home: p3.id,
      role: "support",
      units: { [firstUnit(p3)]: 2 },
    });
  }
  return matchFromState(state, ruleset, { setup, domain, invariants: o.invariants ?? "step" });
}

/** A part of the units at home of `city`, or all of them (no settler unless `settlers`). */
function partOf(r: ReadCtx, rng: Rng, city: CityId, settlers = false): UnitCounts {
  const home = r.state.cities[city] === undefined ? {} : unitsAtHome(r, city);
  const out: UnitCounts = {};
  const all = percent(rng, 30);
  for (const [u, n] of Object.entries(home).toSorted(([a], [b]) => byText(a, b))) {
    if (!settlers && u === r.rules.roles.settler) continue;
    const take = all ? n : Math.ceil((n * randInt(rng, 1, 4)) / 4);
    if (take > 0) out[u] = take;
  }
  return out;
}

export type IntentKind =
  | "build"
  | "recruit"
  | "cancel_queue"
  | "send_resources"
  | "attack"
  | "support"
  | "spy"
  | "recall"
  | "recall_stationed"
  | "dismiss"
  | "found_city"
  | "send_message"
  | "propose"
  | "answer"
  | "leave"
  | "ext"
  | "junk";

const WEIGHTS: readonly (readonly [IntentKind, number])[] = [
  ["build", 6],
  ["recruit", 6],
  ["cancel_queue", 1],
  ["send_resources", 2],
  ["attack", 4],
  ["support", 3],
  ["spy", 2],
  ["recall", 2],
  ["recall_stationed", 4],
  ["dismiss", 1],
  ["found_city", 2],
  ["send_message", 2],
  ["propose", 5],
  ["answer", 6],
  ["leave", 1],
  ["ext", 1],
  ["junk", 3],
];
const TOTAL = WEIGHTS.reduce((a, [, w]) => a + w, 0);

/** One action of `seat` resolved against `r`: mostly valid, sometimes junk (still schema-valid). */
export function intent(r: ReadCtx, seat: PlayerId, rng: Rng): Action {
  let roll = randInt(rng, 0, TOTAL - 1);
  const kind = WEIGHTS.find(([, w]) => (roll -= w) < 0)?.[0] ?? "junk";
  return intentOf(kind, r, seat, rng);
}

/** One action of `kind` for `seat`, resolved against `r`. */
export function intentOf(kind: IntentKind, r: ReadCtx, seat: PlayerId, rng: Rng): Action {
  const s = r.state;
  const players = sortedIds(s.players).filter((p) => s.players[p]?.alive === true);
  const others = players.filter((p) => p !== seat);
  const cities = sortedIds(s.cities);
  const own = cities.filter((c) => s.cities[c]?.owner === seat);
  const from = pick(rng, own) ?? "c999";
  const foreign = cities.filter((c) => s.cities[c]?.owner !== seat);
  const to = pick(rng, foreign) ?? "c999";
  const other = pick(rng, others) ?? "p99";
  switch (kind) {
    case "build":
      return { type: "build", city: from, building: pick(rng, r.rules.buildings)?.id ?? "hut" };
    case "recruit": {
      const unit = pick(rng, r.rules.units)?.id ?? "peon";
      return { type: "recruit", city: from, unit, count: randInt(rng, 1, 8) };
    }
    case "cancel_queue": {
      const c = s.cities[from];
      const items = c === undefined ? [] : [...c.build, ...Object.values(c.recruit).flat()];
      return { type: "cancel_queue", city: from, item: pick(rng, items)?.id ?? randInt(rng, 1, 9) };
    }
    case "send_resources": {
      const res = {
        wood: randInt(rng, 0, 80),
        stone: randInt(rng, 0, 40),
        gold: randInt(rng, 0, 40),
      };
      return { type: "send_resources", from, to: pick(rng, cities) ?? to, res };
    }
    case "attack":
      // Settlers ride along at times: a perfidia-1 conquest (a siege) needs one to survive.
      return { type: "attack", from, to, units: partOf(r, rng, from, percent(rng, 40)) };
    case "support":
      return { type: "support", from, to: pick(rng, cities) ?? to, units: partOf(r, rng, from) };
    case "spy":
      return { type: "spy", from, to, gold: randInt(rng, 0, 120) };
    case "recall": {
      const moving = sortedIds(s.movements).filter((m) => s.movements[m]?.owner === seat);
      return { type: "recall", movement: pick(rng, moving) ?? "m00000" };
    }
    case "recall_stationed": {
      const holding = cities
        .map((c) => {
          const groups = s.cities[c]?.stationed.filter((g) => g.owner === seat) ?? [];
          return { c, groups, homes: [...new Set(groups.map((g) => g.home))].toSorted(byText) };
        })
        .filter((x) => x.groups.length > 0)
        .toSorted((a, b) => b.homes.length - a.homes.length || byText(a.c, b.c));
      const at = (percent(rng, 70) ? holding[0] : pick(rng, holding)) ?? holding[0];
      if (at === undefined) return { type: "recall_stationed", at: to, home: null, units: null };
      const draw = randInt(rng, 0, 9);
      const mode = draw === 0 ? 0 : draw <= 2 ? 1 : draw <= 7 ? 2 : 3;
      const home = mode === 1 || mode === 2 ? (pick(rng, at.homes) ?? null) : null;
      const g = at.groups.find((x) => x.home === home) ?? at.groups[0];
      const unit = Object.keys(g?.units ?? {}).toSorted(byText)[0];
      const units = mode >= 2 && unit !== undefined ? { [unit]: 1 } : null;
      return { type: "recall_stationed", at: at.c, home, units };
    }
    case "dismiss": {
      const guests = own.flatMap((c) =>
        (s.cities[c]?.stationed ?? [])
          .filter((g) => g.owner !== seat)
          .map((g) => ({ city: c, player: g.owner })),
      );
      const guest = pick(rng, guests) ?? { city: from, player: other };
      return { type: "dismiss", ...guest };
    }
    case "found_city": {
      const island = pick(rng, sortedIds(s.islands)) ?? "i999";
      return { type: "found_city", from, island, units: partOf(r, rng, from, true), slot: null };
    }
    case "send_message":
      return {
        type: "send_message",
        to: percent(rng, 25) ? "all" : [other],
        text: `hello from ${seat} at ${r.now}`,
      };
    case "propose": {
      const partners = s.pacts.flatMap((p) => (p.a === seat ? [p.b] : p.b === seat ? [p.a] : []));
      const partner = pick(rng, partners);
      if (partner !== undefined && percent(rng, 75)) {
        const name = s.players[seat]?.alliance === null ? `Bloc ${seat}` : null;
        return { type: "propose", to: partner, kind: "alliance", name, text: "", until: null };
      }
      const k = percent(rng, 70) ? "pact" : "alliance";
      const name = k === "alliance" ? `League ${seat}` : null;
      return { type: "propose", to: other, kind: k, name, text: "deal", until: null };
    }
    case "answer": {
      const open = sortedIds(s.proposals).filter((q) => s.proposals[q]?.to === seat);
      return { type: "answer", proposal: pick(rng, open) ?? "q00000", accept: percent(rng, 85) };
    }
    case "leave":
      return { type: "leave", with: percent(rng, 50) ? null : other };
    case "ext": {
      const tool = pick(
        rng,
        (r.ruleset.tools ?? []).filter((t) => t.kind !== "read"),
      );
      if (tool === undefined) return { type: "leave", with: other };
      return {
        type: "ext",
        tool: tool.name,
        args: { city: from, name: `Fort ${randInt(rng, 1, 99)}` },
      };
    }
    case "junk":
    default: {
      const junk: Action[] = [
        { type: "build", city: "c999", building: "nothing" },
        { type: "attack", from, to: from, units: {} },
        { type: "support", from: to, to: from, units: { nothing: 1 } },
        { type: "recall", movement: "m00000" },
        { type: "answer", proposal: "q00000", accept: true },
        { type: "found_city", from, island: "i999", units: {}, slot: 3 },
        { type: "recruit", city: to, unit: "nothing", count: 1 },
        { type: "ext", tool: "conquer_world", args: {} },
        { type: "dismiss", city: to, player: seat },
        { type: "propose", to: seat, kind: "pact", name: null, text: "", until: 5 },
      ];
      return pick(rng, junk) ?? { type: "recall", movement: "m00000" };
    }
  }
}
