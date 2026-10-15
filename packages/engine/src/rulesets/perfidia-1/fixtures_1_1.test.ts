// Test helpers of the perfidia-1@1.1.0 hook tests (no tests here): hand-built 1.1.0 worlds, run
// through the kernel with the test domain of `fixtures.test.ts` and step invariants.

import { MatchConfigError, resolveConfig, type Match } from "@perfidia/engine/kernel";
import {
  addCity,
  addStationed,
  buildState,
  matchFromState,
  scheduleAt,
  type CityOptions,
} from "@perfidia/engine/testing";
import type {
  City,
  CityId,
  CompiledRules,
  GameState,
  Island,
  Json,
  PlayerId,
  UnitCounts,
} from "@perfidia/protocol";
import type { BlocKey } from "./ext.ts";
import type { Perfidia11Config } from "./config_1_1.ts";
import { initialExt11, type Perfidia11Ext, Perfidia11ExtSchema } from "./ext_1_1.ts";
import { ISLANDS, testDomain } from "./fixtures.test.ts";
import { perfidia1_1_1_0 } from "./v1_1_0.ts";
import { SIEGE_END } from "./siege.ts";
import { DOMINATION_END } from "./victory.ts";
import { DOMINATION_OPEN } from "./world.ts";

export const P11 = perfidia1_1_1_0;

export function configOf11(overrides: Readonly<Record<string, Json>> = {}): Perfidia11Config {
  const resolved = resolveConfig(P11, overrides);
  if (!resolved.ok) throw new MatchConfigError(resolved.errors);
  return resolved.config;
}

export interface World11 {
  readonly state: GameState;
  readonly rules: CompiledRules;
  readonly config: Perfidia11Config;
  /** The same object as `state.ext`, typed. */
  readonly ext: Perfidia11Ext;
}

export interface World11Options {
  /** Default 6. */
  readonly players?: number;
  /** Default 300000 (day 4: domination is open). */
  readonly now?: number;
  readonly open?: boolean;
  readonly islands?: readonly Partial<Island>[];
  readonly overrides?: Readonly<Record<string, Json>>;
}

/** A running 1.1.0 state with players `p1..pN` and no city; the tie-break order is p1..pN. */
export function world11(o: World11Options = {}): World11 {
  const players = o.players ?? 6;
  const now = o.now ?? 300000;
  const config = configOf11(o.overrides);
  const rules = P11.compile(config, players);
  const ids = Array.from({ length: players }, (_, i): PlayerId => `p${i + 1}`);
  const ext = initialExt11(ids, ids);
  const open = o.open ?? now >= config.time.dominationStart;
  ext.domination.open = open;
  const state = buildState({ rules, players, seed: 11, now, islands: o.islands ?? ISLANDS, ext });
  state.ext = ext;
  if (!open)
    scheduleAt(state, rules, DOMINATION_OPEN, Math.max(now, config.time.dominationStart), "");
  return { state, rules, config, ext };
}

/** A city with 1.1.0's building ids (every building at 0 unless given). */
export function city11(w: World11, o: CityOptions): City {
  return addCity(w.state, w.rules, o);
}

/** `n` cities of `owner` with ids from `first`, spread over the test islands. */
export function cities11(w: World11, owner: PlayerId, first: number, n: number): CityId[] {
  const ids: CityId[] = [];
  for (let i = 0; i < n; i += 1) {
    const id: CityId = `c${first + i}`;
    city11(w, { id, owner, island: `i${1 + (i % 4)}` });
    ids.push(id);
  }
  return ids;
}

/** Loads a hand-built 1.1.0 world as a match on the test domain, with step invariants. */
export function load11(w: World11, overrides: Readonly<Record<string, Json>> = {}): Match {
  return matchFromState(w.state, P11, { domain: testDomain, overrides });
}

/** The typed 1.1.0 `ext` of a match. */
export function extOf11(match: Match): Perfidia11Ext {
  return Perfidia11ExtSchema.parse(match.read().state.ext);
}

/** A siege of `city` by `by`, with its garrison (`hold` groups by home) and `siege_end` event. */
export function besiege11(
  w: World11,
  o: {
    readonly city: CityId;
    readonly by: PlayerId;
    readonly garrison: readonly { readonly home: CityId; readonly units: UnitCounts }[];
    readonly endsAt: number;
  },
): void {
  for (const g of o.garrison) {
    addStationed(w.state, o.city, { owner: o.by, home: g.home, role: "hold", units: g.units });
  }
  const seq = scheduleAt(w.state, w.rules, SIEGE_END, o.endsAt, o.city);
  w.ext.sieges[o.city] = { by: o.by, startedAt: w.state.now, endsAt: o.endsAt, seq };
}

/** A running domination countdown of a bloc, with its `domination_end` event. */
export function countdown11(
  w: World11,
  o: { readonly bloc: BlocKey; readonly members: readonly PlayerId[]; readonly endsAt: number },
): void {
  const seq = scheduleAt(w.state, w.rules, DOMINATION_END, o.endsAt, o.bloc);
  w.ext.domination.countdowns = [
    ...w.ext.domination.countdowns,
    { bloc: o.bloc, members: [...o.members], startedAt: w.state.now, endsAt: o.endsAt, seq },
  ].toSorted((a, b) => (a.bloc < b.bloc ? -1 : a.bloc > b.bloc ? 1 : 0));
}

/** Records that `by` took `city` from `former` (the city must be `by`'s). */
export function taken11(w: World11, city: CityId, by: PlayerId, former: readonly PlayerId[]): void {
  w.ext.conquests[city] = { by, former: [...former] };
}
