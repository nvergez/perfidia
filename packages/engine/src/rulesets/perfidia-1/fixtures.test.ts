// Test helpers shared by the perfidia-1 hook tests. This file holds no tests of its own; it is
// named `*.test.ts` so that it stays out of the published sources and gets the test tsconfig.
//
// The domain module is written in parallel (T10), so the tests run the hooks through the kernel
// with the testing kit's fake domain, extended with launches, recalls and stationed recalls built
// on `std` the way the domain's handlers are specified (generic checks, then `hooks.departure`,
// then `std.launch`; `std.turnBack`; `std.unstation` + `std.startReturn`).

import type {
  ActionHandler,
  DepartureDraft,
  DomainModule,
  ReadCtx,
} from "@perfidia/engine/contracts";
import { MatchConfigError, resolveConfig, type Match } from "@perfidia/engine/kernel";
import {
  defaultDeparture,
  launch,
  startReturn,
  turnBack,
  unitsAtHome,
  unstation,
} from "@perfidia/engine/std";
import {
  addCity,
  addStationed,
  buildState,
  fakeDomain,
  matchFromState,
  scheduleAt,
  type CityOptions,
} from "@perfidia/engine/testing";
import {
  type ActionOf,
  type City,
  type CityId,
  type CompiledRules,
  type DomainEvent,
  type GameState,
  type Island,
  type Json,
  type PlayerId,
  type Res,
  type UnitCounts,
  type Violation,
} from "@perfidia/protocol";
import type { PerfidiaConfig } from "./config.ts";
import { type BlocKey, initialExt, type PerfidiaExt, PerfidiaExtSchema } from "./ext.ts";
import { DOMINATION_OPEN } from "./map.ts";
import { SIEGE_END } from "./siege.ts";
import { perfidia1_1_0_0 } from "./v1_0_0.ts";
import { DOMINATION_END } from "./victory.ts";

export const P1 = perfidia1_1_0_0;

export function configOf(overrides: Readonly<Record<string, Json>> = {}): PerfidiaConfig {
  const resolved = resolveConfig(P1, overrides);
  if (!resolved.ok) throw new MatchConfigError(resolved.errors);
  return resolved.config;
}

export interface World {
  readonly state: GameState;
  readonly rules: CompiledRules;
  readonly config: PerfidiaConfig;
  /** The same object as `state.ext`, typed. */
  readonly ext: PerfidiaExt;
}

export interface WorldOptions {
  /** Default 6. */
  readonly players?: number;
  /** Default 200000 (day 3: protection and capital immunity are over, domination is not open). */
  readonly now?: number;
  readonly seed?: number;
  /** Default `now >= dominationStart`; when closed, the `domination_open` timer is queued. */
  readonly open?: boolean;
  /** Default four islands far apart, ten slots each. */
  readonly islands?: readonly Partial<Island>[];
  readonly overrides?: Readonly<Record<string, Json>>;
}

/** Four islands: i1 (0, 0), i2 (90, 0), i3 (0, 300), i4 (300, 300); ten slots each. */
export const ISLANDS: readonly Partial<Island>[] = [
  { x: 0, y: 0, kind: "home", slots: 10, richnessPm: 1000 },
  { x: 90, y: 0, kind: "home", slots: 10, richnessPm: 1000 },
  { x: 0, y: 300, kind: "home", slots: 10, richnessPm: 1000 },
  { x: 300, y: 300, kind: "home", slots: 10, richnessPm: 1000 },
];

/** A running perfidia-1 state with players `p1..pN` and no city; the tie-break order is p1..pN. */
export function world(o: WorldOptions = {}): World {
  const players = o.players ?? 6;
  const now = o.now ?? 200000;
  const config = configOf(o.overrides);
  const rules = P1.compile(config, players);
  const ids = Array.from({ length: players }, (_, i): PlayerId => `p${i + 1}`);
  const ext = initialExt(ids, ids);
  const open = o.open ?? now >= config.time.dominationStart;
  ext.domination.open = open;
  const state = buildState({
    rules,
    players,
    seed: o.seed ?? 11,
    now,
    islands: o.islands ?? ISLANDS,
    ext,
  });
  state.ext = ext;
  if (!open)
    scheduleAt(state, rules, DOMINATION_OPEN, Math.max(now, config.time.dominationStart), "");
  return { state, rules, config, ext };
}

/** A city with perfidia-1's building ids (every building at 0 unless given). */
export function city(w: World, o: CityOptions): City {
  return addCity(w.state, w.rules, o);
}

/** A siege of `city` by `by`, with its garrison (`hold` groups by home) and `siege_end` event. */
export function besiege(
  w: World,
  o: {
    readonly city: CityId;
    readonly by: PlayerId;
    readonly garrison: readonly { readonly home: CityId; readonly units: UnitCounts }[];
    readonly startedAt?: number;
    readonly endsAt?: number;
  },
): void {
  for (const g of o.garrison) {
    addStationed(w.state, o.city, { owner: o.by, home: g.home, role: "hold", units: g.units });
  }
  const startedAt = o.startedAt ?? w.state.now;
  const endsAt = o.endsAt ?? startedAt + w.config.time.siegeDuration;
  const seq = scheduleAt(w.state, w.rules, SIEGE_END, endsAt, o.city);
  w.ext.sieges[o.city] = { by: o.by, startedAt, endsAt, seq };
}

/** A running domination countdown of a bloc, with its `domination_end` event. */
export function countdown(
  w: World,
  o: {
    readonly bloc: BlocKey;
    readonly members: readonly PlayerId[];
    readonly startedAt?: number;
    readonly endsAt?: number;
  },
): void {
  const startedAt = o.startedAt ?? w.state.now;
  const endsAt = o.endsAt ?? startedAt + w.config.time.dominationHold;
  const seq = scheduleAt(w.state, w.rules, DOMINATION_END, endsAt, o.bloc);
  w.ext.domination.countdowns = [
    ...w.ext.domination.countdowns,
    { bloc: o.bloc, members: [...o.members], startedAt, endsAt, seq },
  ].toSorted((a, b) => (a.bloc < b.bloc ? -1 : a.bloc > b.bloc ? 1 : 0));
}

// The test domain ------------------------------------------------------------------------------

type Fail = { ok: false; violation: Violation };

function fail(code: string, details: Violation["details"] = {}): Fail {
  return { ok: false, violation: { code, details } };
}

interface LaunchPlan {
  readonly draft: DepartureDraft;
  readonly party: PlayerId | null;
}

function covers(have: Readonly<UnitCounts>, need: Readonly<UnitCounts>): boolean {
  return Object.entries(need).every(([u, n]) => (have[u] ?? 0) >= (n ?? 0));
}

const ZERO: Res = { wood: 0, stone: 0, gold: 0 };

/** Generic launch checks, then `hooks.departure` (or the std default), as the domain specifies. */
function launchValidate(
  r: ReadCtx,
  seat: PlayerId,
  d: DepartureDraft,
): Fail | { ok: true; plan: LaunchPlan; warnings?: Violation[] } {
  const from = r.state.cities[d.from];
  if (from === undefined) return fail("UNKNOWN_ID", { city: d.from });
  if (from.owner !== seat) return fail("NOT_OWNER", { city: d.from });
  if (!covers(unitsAtHome(r, d.from), d.units)) return fail("INSUFFICIENT_UNITS", { city: d.from });
  if (d.kind === "attack" && r.now < r.rules.time.attackFrom) {
    return fail("ATTACK_PROTECTION", { availableAt: r.rules.time.attackFrom });
  }
  const hooks = r.ruleset.hooks;
  const verdict = hooks.departure === undefined ? defaultDeparture(r, d) : hooks.departure(r, d);
  if (!verdict.ok) return verdict;
  const plan: LaunchPlan = {
    draft: { ...d, units: verdict.units ?? d.units },
    party: verdict.party,
  };
  return verdict.warnings === undefined
    ? { ok: true, plan }
    : { ok: true, plan, warnings: verdict.warnings };
}

function targetIsland(r: ReadCtx, to: CityId): DepartureDraft["island"] {
  return r.state.cities[to]?.island ?? "i1";
}

function launcher<T extends "attack" | "support" | "spy" | "send_resources">(
  type: T,
  draft: (r: ReadCtx, seat: PlayerId, a: ActionOf<T>) => DepartureDraft,
): ActionHandler<ActionOf<T>, LaunchPlan> {
  return {
    validate: (r, seat, a) => launchValidate(r, seat, draft(r, seat, a)),
    apply: (ctx, _seat, plan) => ({ movement: launch(ctx, plan.draft, plan.party) }),
  };
}

const recall: ActionHandler<ActionOf<"recall">, ActionOf<"recall">> = {
  validate(r, seat, a) {
    const m = r.state.movements[a.movement];
    if (m === undefined || m.owner !== seat) return fail("UNKNOWN_ID", { movement: a.movement });
    const rule = r.rules.movement.recall;
    const kinds: readonly string[] = rule.kinds;
    if (!kinds.includes(m.kind) || r.now - m.departAt > rule.window) {
      return fail("NOT_RECALLABLE", { movement: a.movement });
    }
    return { ok: true, plan: a };
  },
  apply(ctx, _seat, a) {
    turnBack(ctx, a.movement);
    return { movement: a.movement };
  },
};

const recallStationed: ActionHandler<ActionOf<"recall_stationed">, ActionOf<"recall_stationed">> = {
  validate(r, seat, a) {
    const c = r.state.cities[a.at];
    if (c === undefined || a.home === null) return fail("INVALID_ARGS", { city: a.at });
    if (!c.stationed.some((g) => g.owner === seat && g.home === a.home)) {
      return fail("NOTHING_STATIONED", { city: a.at });
    }
    return { ok: true, plan: a };
  },
  apply(ctx, seat, a) {
    const home = a.home ?? a.at;
    const units = unstation(ctx, a.at, seat, home, a.units ?? undefined);
    return { movement: startReturn(ctx, { owner: seat, home, from: a.at, units }) };
  },
};

/** The fake domain with std-based launches, recalls and stationed recalls. */
export const testDomain: DomainModule = {
  ...fakeDomain,
  actions: {
    ...fakeDomain.actions,
    attack: launcher("attack", (r, seat, a) => ({
      kind: "attack",
      owner: seat,
      from: a.from,
      to: a.to,
      island: targetIsland(r, a.to),
      slot: null,
      units: a.units,
      cargo: ZERO,
      gold: 0,
    })),
    support: launcher("support", (r, seat, a) => ({
      kind: "support",
      owner: seat,
      from: a.from,
      to: a.to,
      island: targetIsland(r, a.to),
      slot: null,
      units: a.units,
      cargo: ZERO,
      gold: 0,
    })),
    spy: launcher("spy", (r, seat, a) => ({
      kind: "spy",
      owner: seat,
      from: a.from,
      to: a.to,
      island: targetIsland(r, a.to),
      slot: null,
      units: {},
      cargo: ZERO,
      gold: a.gold,
    })),
    send_resources: launcher("send_resources", (r, seat, a) => ({
      kind: "shipment",
      owner: seat,
      from: a.from,
      to: a.to,
      island: targetIsland(r, a.to),
      slot: null,
      units: {},
      cargo: a.res,
      gold: 0,
    })),
    recall,
    recall_stationed: recallStationed,
  },
};

/** Loads a hand-built world as a match on the test domain, with step invariants. */
export function load(w: World, overrides: Readonly<Record<string, Json>> = {}): Match {
  return matchFromState(w.state, P1, { domain: testDomain, overrides });
}

/** The typed `ext` of a match. */
export function extOf(match: Match): PerfidiaExt {
  return PerfidiaExtSchema.parse(match.read().state.ext);
}

/** The events of one type. */
export function ofType(events: readonly DomainEvent[], type: string): DomainEvent[] {
  return events.filter((e) => e.type === type);
}

/** The only event of one type addressed to `p`. */
export function copyFor(events: readonly DomainEvent[], type: string, p: PlayerId): DomainEvent {
  const found = events.filter((e) => e.type === type && e.to.some((x) => x.p === p));
  if (found.length !== 1) {
    throw new Error(`expected one ${type} for ${p}, found ${found.length}`);
  }
  const [e] = found;
  if (e === undefined) throw new Error(`no ${type} for ${p}`);
  return e;
}

/** A movement of the match by owner and kind (the only one). */
export function movementBy(match: Match, owner: PlayerId, kind: string) {
  const found = Object.values(match.read().state.movements).filter(
    (m) => m.owner === owner && m.kind === kind,
  );
  if (found.length !== 1)
    throw new Error(`expected one ${kind} of ${owner}, found ${found.length}`);
  const [m] = found;
  if (m === undefined) throw new Error(`no ${kind} of ${owner}`);
  return m;
}

/** A city of the match. */
export function cityIn(match: Match, id: CityId) {
  const c = match.read().state.cities[id];
  if (c === undefined) throw new Error(`no city ${id}`);
  return c;
}

/** Plain JSON of a value (for `toEqual` on deep-readonly state). */
export function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
