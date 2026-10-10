// Test helpers shared by the sandbox-1 tests. This file holds no tests of its own; it is named
// `*.test.ts` so that it stays out of the published sources and gets the test tsconfig and lint.
//
// The domain module is written in parallel (T10), so kernel tests run on the testing kit's fake
// domain, with std's `arriveHome` for returns (it adds the loot) and std's invariants in place of
// the fake's own conservation check: every step of a sandbox-1 hook must keep them.

import type { DomainModule } from "@perfidia/engine/contracts";
import { MatchConfigError, resolveConfig, type Match } from "@perfidia/engine/kernel";
import { arriveHome, stdInvariants } from "@perfidia/engine/std";
import {
  addCity,
  buildState,
  fakeDomain,
  matchFromState,
  scheduleAt,
  type CityOptions,
} from "@perfidia/engine/testing";
import {
  CityIdSchema,
  type City,
  type CompiledRules,
  type DeepReadonly,
  type DomainEvent,
  type GameState,
  type Json,
  type PlayerId,
} from "@perfidia/protocol";
import { HILL_OPEN } from "./compile.ts";
import type { SandboxConfig } from "./config.ts";
import { sandbox1_1_0_0 } from "./descriptor.ts";
import { layoutIslands } from "./map.ts";

/** The fake domain with std's return arrival and std's invariants. */
export const TEST_DOMAIN: DomainModule = {
  ...fakeDomain,
  arrivals: { ...fakeDomain.arrivals, return: (ctx, m) => arriveHome(ctx, m) },
  invariants: [...stdInvariants],
};

export type Overrides = Readonly<Record<string, Json>>;

/** The effective config under `overrides` (throws on an invalid set). */
export function sandboxConfig(overrides: Overrides = {}): DeepReadonly<SandboxConfig> {
  const resolved = resolveConfig(sandbox1_1_0_0, overrides);
  if (!resolved.ok) throw new MatchConfigError(resolved.errors);
  return resolved.config;
}

/** The compiled rules for N players under `overrides`. */
export function sandboxRules(players: number, overrides: Overrides = {}): CompiledRules {
  return sandbox1_1_0_0.compile(sandboxConfig(overrides), players);
}

export interface StateOptions {
  readonly players: number;
  readonly now?: number;
  readonly seed?: number;
  readonly overrides?: Overrides;
  /** Default: whether `now ≥ time.hillOpen`. */
  readonly hillOpen?: boolean;
}

/**
 * A hand-built running state on the real map of N players, with no city yet: `ext` and the
 * `hill_open` timer are consistent with the hill flag.
 */
export function sandboxState(o: StateOptions): {
  state: GameState;
  rules: CompiledRules;
  config: DeepReadonly<SandboxConfig>;
} {
  const config = sandboxConfig(o.overrides);
  const rules = sandbox1_1_0_0.compile(config, o.players);
  const now = o.now ?? 0;
  const open = o.hillOpen ?? now >= config.time.hillOpen;
  const state = buildState({
    rules,
    players: o.players,
    seed: o.seed ?? 1,
    now,
    islands: layoutIslands(config, o.players),
    ext: { hillOpen: open },
  });
  if (!open) scheduleAt(state, rules, HILL_OPEN, config.time.hillOpen, "");
  return { state, rules, config };
}

/** A city with the start buildings at level 1 (keep, sawmill, pit, forge, depot) unless given. */
export function sandboxCity(state: GameState, rules: CompiledRules, o: CityOptions): City {
  return addCity(state, rules, {
    ...o,
    buildings: o.buildings ?? { keep: 1, sawmill: 1, pit: 1, forge: 1, depot: 1 },
  });
}

/** Loads a hand-built state as a sandbox-1 match on the test domain, with step invariants. */
export function sandboxMatch(state: GameState, overrides: Overrides = {}): Match {
  return matchFromState(state, sandbox1_1_0_0, { domain: TEST_DOMAIN, overrides });
}

/** The events of one type. */
export function ofType(events: readonly DomainEvent[], type: string): DomainEvent[] {
  return events.filter((e) => e.type === type);
}

/** The single event of a type addressed to `p` (throws when there is not exactly one). */
export function to(events: readonly DomainEvent[], type: string, p: PlayerId): DomainEvent {
  const found = events.filter((e) => e.type === type && e.to.some((x) => x.p === p));
  if (found.length !== 1) throw new Error(`expected one ${type} to ${p}, got ${found.length}`);
  const [e] = found;
  if (e === undefined) throw new Error("unreachable");
  return e;
}

/** A city of the match (throws when missing). */
export function cityOf(match: Match, id: string): DeepReadonly<City> {
  const c = match.read().state.cities[CityIdSchema.parse(id)];
  if (c === undefined) throw new Error(`no city ${id}`);
  return c;
}
